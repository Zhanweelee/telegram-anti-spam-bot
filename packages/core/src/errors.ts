export class PipelineConfigError extends Error {
  constructor(
    code:
      | "invalid_detector_timeout"
      | "duplicate_detector"
      | "duplicate_action",
  ) {
    super(code);
    this.name = "PipelineConfigError";
  }
}

export class RawContentError extends Error {
  constructor() {
    super("raw_content_rejected");
    this.name = "RawContentError";
  }
}
