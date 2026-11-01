// Fixed public metadata and an empty credential only. Never uses a real code.
import { REVIEW_SETUP_PAGE, REVIEW_SETUP_CSP } from '../src/review_setup_page.mjs';
const origin = 'https://soul-reader-billing.jgw98541706.workers.dev';
try {
  const helper = await fetch(`${origin}/setup/review-access`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (helper.status !== 200 || helper.headers.get('content-security-policy') !== REVIEW_SETUP_CSP
    || await helper.text() !== REVIEW_SETUP_PAGE) throw new Error();
  const response = await fetch(`${origin}/v1/review-access`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'play-review', accessCode: '' }),
  });
  const value = await response.json();
  if (response.status === 401 && value?.error?.code === 'review_access_denied') {
    console.log('Review helper is public; review login rejects an empty credential. Owner must still verify the actual private code in their browser/app.');
  } else if (response.status === 503 && value?.error?.code === 'review_configuration_required') {
    console.log('::notice::Review helper is public; review login remains disabled until the owner configures PLAY_REVIEW_ACCESS_CODE in Cloudflare. Actual reviewer access has NOT been verified.');
  } else throw new Error();
} catch {
  console.error('::error::Review helper/login boundary could not be verified. No credentials or response content were logged.');
  process.exitCode = 1;
}
