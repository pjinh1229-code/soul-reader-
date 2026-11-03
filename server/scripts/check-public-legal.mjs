// Public static pages only; never authenticates or accesses user data.
import { pathToFileURL } from 'node:url';

const origin = 'https://soul-reader-billing.jgw98541706.workers.dev';
export const ADMOB_SELLER_LINE = 'google.com, pub-1953724823797056, DIRECT, f08c47fec0942fa0\n';

export async function checkPublicLegal({ fetchImpl = fetch, report = console.log } = {}) {
  for (const [path, heading] of [['/', '서비스 안내'], ['/privacy', '개인정보처리방침'], ['/delete-account', '계정 및 데이터 삭제 요청']]) {
    const response = await fetchImpl(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('text/html')
      || !response.headers.get('content-security-policy')?.includes("form-action 'none'")) {
      throw new Error('public_page_unavailable');
    }
    const html = await response.text();
    if (html.length > 50000 || !html.includes(`<h1>${heading}</h1>`) || !html.includes('SOUL READER 운영자')
      || !html.includes('com.soulreader.soul_reader') || !html.includes('jgw98541706@gmail.com')
      || /<form\b|<script\b/i.test(html)) throw new Error('public_page_invalid');
    if (path === '/' && (!html.includes('href="/privacy"') || !html.includes('href="/delete-account"'))) {
      throw new Error('public_home_invalid');
    }
    if (path !== '/' && !html.includes('서비스 운영 기간')) throw new Error('public_page_invalid');
    if (path === '/privacy' && ['광고 기능이 포함된 버전에서는', '광고 기능이 없는 기존 버전에는 광고 SDK가 없으며',
      'AdMob(Google Mobile Ads SDK)', 'UMP', 'IP 주소와 그로부터 추정한 대략적 위치',
      '비개인 맞춤 광고·테스트 광고'].some(marker => !html.includes(marker))) {
      throw new Error('public_ads_privacy_invalid');
    }
    report(`Public ${path} is accessible without authentication.`);
  }

  const seller = await fetchImpl(`${origin}/app-ads.txt`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (seller.status !== 200 || !seller.headers.get('content-type')?.startsWith('text/plain')
    || await seller.text() !== ADMOB_SELLER_LINE) throw new Error('public_admob_seller_invalid');
  report('Public /app-ads.txt matches the owner AdMob seller declaration.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkPublicLegal();
  } catch {
    console.error('::error::Public service/privacy/deletion pages or AdMob seller declaration could not be verified. No credentials or response content were logged.');
    process.exitCode = 1;
  }
}
