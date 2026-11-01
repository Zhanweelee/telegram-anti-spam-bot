/** Last-stage classifier. Implementations live in adapters. Core does no I/O. */
export interface LlmVerdict {
  readonly label: string;
  readonly score: number;
}

export interface LlmClassifier {
  classify(text: string): Promise<LlmVerdict>;
}
