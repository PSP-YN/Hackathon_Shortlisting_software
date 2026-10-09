import { google } from 'googleapis';
import { getGoogleAuthClient } from './auth';
import * as pdfParseModule from 'pdf-parse';
const pdfParse = (pdfParseModule as any).default || pdfParseModule;
import JSZip from 'jszip';

export interface ExtractedPresentationContent {
  rawText: string;
  slides: Array<{
    slideNumber: number;
    title?: string;
    text: string;
  }>;
  totalSlides: number;
  fileType: 'google_slides' | 'pdf' | 'pptx' | 'unknown';
  fileName: string;
  warnings: string[];
}

/**
 * Extracts Google Drive / Docs / Slides File ID from various URL formats.
 */
export function extractGoogleDriveFileId(url: string): string | null {
  if (!url) return null;
  // Match /presentation/d/{id}
  const presentationMatch = url.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (presentationMatch) return presentationMatch[1];

  // Match /file/d/{id}
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];

  // Match ?id={id}
  const idParamMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];

  // Match bare ID (alphanumeric with underscores/hyphens > 20 chars)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(url.trim())) {
    return url.trim();
  }

  return null;
}

export async function fetchAndExtractPresentation(
  presentationUrl: string
): Promise<ExtractedPresentationContent> {
  const warnings: string[] = [];

  if (!presentationUrl || !presentationUrl.trim()) {
    throw new Error('Presentation URL is empty or missing.');
  }

  const fileId = extractGoogleDriveFileId(presentationUrl);

  if (!fileId) {
    // If it's a direct web URL to a PDF
    if (presentationUrl.toLowerCase().endsWith('.pdf')) {
      return extractFromDirectPdfUrl(presentationUrl);
    }
    throw new Error(
      `Invalid presentation link format: "${presentationUrl}". Please provide an authorized Google Drive, Google Slides, or PDF URL.`
    );
  }

  const { auth, clientEmail } = getGoogleAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  let fileMeta;
  try {
    const metaRes = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType',
    });
    fileMeta = metaRes.data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('404') || message.includes('File not found')) {
      throw new Error(
        `Presentation file not found (ID: ${fileId}). Verify the link or check if it was deleted.`
      );
    }
    if (message.includes('403') || message.includes('permission') || message.includes('The caller does not have permission')) {
      throw new Error(
        `Permission denied accessing presentation (ID: ${fileId}). Ensure the Google presentation is shared with the service account: ${clientEmail}`
      );
    }
    throw new Error(`Failed to access presentation file (ID: ${fileId}): ${message}`);
  }

  const mimeType = fileMeta.mimeType || '';
  const fileName = fileMeta.name || 'Untitled Presentation';

  // 1. Google Slides presentation
  if (mimeType === 'application/vnd.google-apps.presentation') {
    try {
      const exportRes = await drive.files.export({
        fileId,
        mimeType: 'text/plain',
      });

      const textContent = String(exportRes.data || '');
      // Google Slides plain text export separates slides or paragraphs
      const slideChunks = textContent.split(/\n\s*\n\s*\n/).filter((c) => c.trim().length > 0);

      const slides = slideChunks.map((chunk, index) => {
        const lines = chunk.trim().split('\n');
        return {
          slideNumber: index + 1,
          title: lines[0] ? lines[0].slice(0, 80) : `Slide ${index + 1}`,
          text: chunk.trim(),
        };
      });

      return {
        rawText: textContent,
        slides: slides.length > 0 ? slides : [{ slideNumber: 1, text: textContent }],
        totalSlides: slides.length > 0 ? slides.length : 1,
        fileType: 'google_slides',
        fileName,
        warnings,
      };
    } catch (err) {
      warnings.push(`Google Slides direct export failed, attempting media fetch fallback: ${err}`);
    }
  }

  // 2. PDF stored in Google Drive
  if (mimeType === 'application/pdf') {
    const mediaRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const buffer = Buffer.from(mediaRes.data as ArrayBuffer);
    const pdfData = await pdfParse(buffer);

    const pages = pdfData.text.split('\f').filter((p: string) => p.trim().length > 0);
    const slides = pages.map((pageText: string, idx: number) => ({
      slideNumber: idx + 1,
      title: pageText.trim().split('\n')[0]?.slice(0, 80) || `Page ${idx + 1}`,
      text: pageText.trim(),
    }));

    return {
      rawText: pdfData.text,
      slides,
      totalSlides: pdfData.numpages || slides.length,
      fileType: 'pdf',
      fileName,
      warnings,
    };
  }

  // 3. PPTX stored in Google Drive
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    fileName.toLowerCase().endsWith('.pptx')
  ) {
    const mediaRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const buffer = Buffer.from(mediaRes.data as ArrayBuffer);
    return extractFromPptxBuffer(buffer, fileName);
  }

  // Fallback: try reading as PDF or text
  throw new Error(
    `Unsupported file format (${mimeType || 'unknown'}) for file "${fileName}". Please provide a Google Slides, PDF, or PPTX presentation.`
  );
}

async function extractFromPptxBuffer(
  buffer: Buffer,
  fileName: string
): Promise<ExtractedPresentationContent> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files).filter((name) =>
    name.startsWith('ppt/slides/slide') && name.endsWith('.xml')
  );

  // Sort slides numerically (slide1.xml, slide2.xml, ...)
  slideFiles.sort((a, b) => {
    const numA = parseInt(a.replace(/[^\d]/g, ''), 10) || 0;
    const numB = parseInt(b.replace(/[^\d]/g, ''), 10) || 0;
    return numA - numB;
  });

  const slides: Array<{ slideNumber: number; title?: string; text: string }> = [];
  let fullText = '';

  for (let i = 0; i < slideFiles.length; i++) {
    const slideXml = await zip.files[slideFiles[i]].async('text');
    // Extract text inside <a:t> tags
    const textMatches = slideXml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || [];
    const slideText = textMatches
      .map((tag) => tag.replace(/<[^>]+>/g, '').trim())
      .filter((t) => t.length > 0)
      .join(' ');

    const title = slideText.slice(0, 80);
    slides.push({
      slideNumber: i + 1,
      title: title || `Slide ${i + 1}`,
      text: slideText,
    });
    fullText += `\n\n--- Slide ${i + 1} ---\n${slideText}`;
  }

  return {
    rawText: fullText.trim(),
    slides,
    totalSlides: slides.length,
    fileType: 'pptx',
    fileName,
    warnings: [],
  };
}

async function extractFromDirectPdfUrl(url: string): Promise<ExtractedPresentationContent> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download PDF from URL (${res.status}): ${url}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const pdfData = await pdfParse(buffer);

  const pages = pdfData.text.split('\f').filter((p: string) => p.trim().length > 0);
  const slides = pages.map((pageText: string, idx: number) => ({
    slideNumber: idx + 1,
    title: pageText.trim().split('\n')[0]?.slice(0, 80) || `Page ${idx + 1}`,
    text: pageText.trim(),
  }));

  return {
    rawText: pdfData.text,
    slides,
    totalSlides: pdfData.numpages || slides.length,
    fileType: 'pdf',
    fileName: url.split('/').pop() || 'document.pdf',
    warnings: [],
  };
}
