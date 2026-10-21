import JSZip from 'jszip';

export interface DocxArchive {
  entries: string[];
  documentXml: string;
  footerXml: string | null;
}

/** Opens a .docx buffer and extracts its main parts. */
export async function openDocx(buffer: Buffer): Promise<DocxArchive> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.keys(zip.files);
  const documentFile = zip.file('word/document.xml');
  const documentXml = documentFile ? await documentFile.async('string') : '';
  const footerFile = zip.file('word/footer1.xml');
  const footerXml = footerFile ? await footerFile.async('string') : null;
  return { entries, documentXml, footerXml };
}

/** Counts the occurrences of a string in the text of the document. */
export function countOccurrences(xml: string, needle: string): number {
  return xml.split(needle).length - 1;
}
