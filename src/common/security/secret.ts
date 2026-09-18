/**
 * A value that must never be printed by accident.
 *
 * Passwords and signing secrets travel inside this wrapper from the moment they
 * are read from the environment. Whatever serialises it - JSON.stringify, a
 * template string, a logger walking an object - sees "[redacted]". The real
 * value is obtained only by an explicit reveal(), which is easy to grep for.
 */
export class Secret {
  readonly #value: string;

  public constructor(value: string) {
    this.#value = value;
  }

  public reveal(): string {
    return this.#value;
  }

  public toJSON(): string {
    return '[redacted]';
  }

  public toString(): string {
    return '[redacted]';
  }

  public [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Secret([redacted])';
  }
}
