// Public static pages only; never authenticates or accesses user data.
const origin = 'https://soul-reader-billing.jgw98541706.workers.dev';
try {
  for (const [path, heading] of [['/privacy', '개인정보처리방침'], ['/delete-account', '계정 및 데이터 삭제 요청']]) {
    const response = await fetch(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('text/html')
      || !response.headers.get('content-security-policy')?.includes("form-action 'none'")) {
      throw new Error('public_page_unavailable');
    }
    const html = await response.text();
    if (html.length > 50000 || !html.includes(`<h1>${heading}</h1>`) || !html.includes('SOUL READER 운영자')
      || !html.includes('com.soulreader.soul_reader') || !html.includes('jgw98541706@gmail.com')
      || !html.includes('서비스 운영 기간') || /<form\b|<script\b/i.test(html)) throw new Error('public_page_invalid');
    console.log(`Public ${path} is accessible without authentication.`);
  }
} catch {
  console.error('::error::Public privacy/deletion pages could not be verified. No credentials or response content were logged.');
  process.exitCode = 1;
}
