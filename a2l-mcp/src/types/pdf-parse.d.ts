declare module "pdf-parse" {
  interface PDFData {
    numpages: number;
    numrender: number;
    info: any;
    metadata: any;
    text: string;
    version: string;
  }

  function pdfParse(dataBuffer: Buffer): Promise<PDFData>;
  export = pdfParse;
}
