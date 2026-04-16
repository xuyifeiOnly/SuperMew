declare module 'word-extractor' {
  interface ExtractedWordDocument {
    getBody(): string;
  }

  export default class WordExtractor {
    extract(input: string | Buffer): Promise<ExtractedWordDocument>;
  }
}
