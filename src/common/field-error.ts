/** One thing wrong with a message, and where it is. */
export interface FieldError {
  /** Where in the message, e.g. "to.address", "attachments[2]", "html". */
  readonly path: string;
  readonly code: string;
  readonly detail: string;
}
