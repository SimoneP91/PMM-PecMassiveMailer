import type {
  WebhookRequest,
  WebhookResponse,
  WebhookTransport,
} from '../../src/modules/webhooks/webhook-transport';

/**
 * Records every notification and answers 200, unless a script was set for
 * the requests whose body contains a given marker (a batch id): scripts are
 * per marker so an unrelated event delivered meanwhile cannot consume them.
 */
export class FakeWebhookTransport implements WebhookTransport {
  public readonly requests: WebhookRequest[] = [];
  private readonly scripts = new Map<string, (number | Error)[]>();

  /** The next requests mentioning `marker` get these answers, in order; then 200. */
  public answer(marker: string, ...outcomes: (number | Error)[]): void {
    this.scripts.set(marker, outcomes);
  }

  public post(request: WebhookRequest): Promise<WebhookResponse> {
    this.requests.push(request);
    const script = [...this.scripts].find(([marker]) => request.body.includes(marker))?.[1];
    const next = script?.shift();
    if (next instanceof Error) {
      return Promise.reject(next);
    }

    return Promise.resolve({ status: next ?? 200 });
  }

  public ofType(type: string): WebhookRequest[] {
    return this.requests.filter((request) => request.headers['x-pecmailer-event'] === type);
  }
}
