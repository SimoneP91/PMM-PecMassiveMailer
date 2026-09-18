import { generateApiKey } from '../common/security/hash';

/**
 * Prints a fresh key and the YAML to paste into config/pecmailer.yaml. The key
 * itself is shown exactly once and stored nowhere: whoever runs this hands it
 * to the client over a channel of their choosing.
 */
export function runApiKeyGenerate(label: string | undefined): number {
  const { key, sha256 } = generateApiKey();
  const keyId = `key_${Date.now().toString(36)}`;

  console.log('API key (give it to the client, it will not be shown again):');
  console.log('');
  console.log(`  ${key}`);
  console.log('');
  console.log("Add under the tenant's apiKeys in config/pecmailer.yaml:");
  console.log('');
  console.log(`      - id: ${keyId}`);
  if (label !== undefined && label !== '') {
    console.log(`        label: ${JSON.stringify(label)}`);
  }
  console.log(`        sha256: ${sha256}`);

  return 0;
}
