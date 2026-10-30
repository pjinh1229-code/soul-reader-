// Public service information only. These pages never read authentication,
// purchase records, query parameters, or billing runtime secrets.
export const SUPPORT_EMAIL = 'jgw98541706@gmail.com';
export const SERVICE_OPERATOR = 'SOUL READER 운영자';
export const LEGAL_UPDATED = '2026-10-30';

const escape = value => String(value).replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const mail = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('[SOUL READER] 계정 및 데이터 삭제 요청')}&body=${encodeURIComponent('SOUL READER 계정 및 연결된 데이터 삭제를 요청합니다.\n\n앱 로그인에 사용한 Google 이메일: \n삭제 범위: 계정 및 연결된 데이터 전체\n\n이 이메일을 앱 로그인에 사용한 주소에서 보내주세요. 비밀번호, 인증 코드, 구매 토큰, 서비스 계정 키, 신분증 또는 사진을 첨부하지 마세요.')}`;
const stylesheet = `:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif;line-height:1.8}body{margin:0;background:#17121f;color:#f5edf6}main{max-width:760px;padding:28px 22px 64px;margin:auto}h1{font-size:1.7rem;line-height:1.45}h2{font-size:1.15rem;margin-top:32px}a{color:#f1c9e1;overflow-wrap:anywhere}li{margin:.5em 0}nav{display:flex;gap:20px;flex-wrap:wrap}.note{padding:16px;border:1px solid #70546b;border-radius:12px}.button{display:inline-block;padding:12px 18px;border-radius:10px;background:#f1c9e1;color:#241428;text-decoration:none;font-weight:bold}small{color:#d2bed4}strong{color:#ffe1ed}footer{margin-top:36px;border-top:1px solid #70546b;padding-top:20px}`;
function page(title, content) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(title)} · SOUL READER</title><style>${stylesheet}</style></head><body><main><nav aria-label="서비스 안내"><a href="/privacy">개인정보처리방침</a><a href="/delete-account">계정 및 데이터 삭제 요청</a></nav><h1>${escape(title)}</h1><p><strong>SOUL READER</strong> · Android 패키지 <span>com.soulreader.soul_reader</span><br><small>최종 수정: ${LEGAL_UPDATED}</small></p>${content}<footer>운영자: ${escape(SERVICE_OPERATOR)}<br>개인정보 및 계정 문의: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></footer></main></body></html>`;
}

export const PRIVACY_PAGE = page('개인정보처리방침', `
<p>이 방침은 SOUL READER 앱의 사진 기반 오락용 풀이, Google 로그인, Google Play 인앱 구매 및 구매 내역 복원에 적용됩니다.</p>
<h2>1. 사진과 풀이 기록</h2>
<p>사용자가 선택하거나 촬영한 사진은 기기에서 얼굴을 감지하고 풀이를 만드는 데 사용합니다. 앱은 사진이나 얼굴 윤곽·좌표를 구매 확인 서버로 전송하지 않습니다. 얼굴 감지는 신원 확인이나 생체 인증을 위한 기능이 아닙니다.</p>
<p>사진 처리 중 기기의 메모리·임시 파일·캐시가 사용될 수 있습니다. 풀이 기록과 얼굴 특징에서 계산한 수치, 선택한 주제 등은 기기에 저장될 수 있습니다. 원래 갤러리 사진은 앱의 계정 삭제로 지워지지 않습니다.</p>
<h2>2. Google 로그인</h2>
<p>무료 풀이에 Google 로그인을 요구하지 않습니다. 구매와 구매 내역 확인에는 Google/Firebase 로그인을 사용합니다. 로그인 과정에서 Google/Firebase가 이름, 이메일 주소, 계정 고유 식별자와 인증 정보를 처리하며, 앱에는 로그인한 계정의 이름 또는 이메일이 표시될 수 있습니다.</p>
<p>구매 확인 서버는 Firebase 인증 토큰을 확인하고 계정 고유 식별자로 구매를 구분합니다. 앱은 Google 계정 비밀번호를 수집하지 않습니다.</p>
<h2>3. 구매 확인과 서버에 보관되는 정보</h2>
<p>구매 확인·복원·환불 반영·부정 사용 방지를 위해 계정 식별자, 상품 및 구매 식별 정보, 암호화한 구매 토큰, 사진별 풀이를 구분하는 임의 식별자, 선택한 주제, 구매 상태와 처리 시각을 Cloudflare 서버와 데이터베이스에서 처리합니다. 이 서버에는 사진 자체나 얼굴 좌표를 저장하지 않습니다.</p>
<p>결제는 Google Play에서 처리합니다. 카드 번호나 결제 수단 비밀번호는 이 앱의 구매 확인 서버에 전달되지 않습니다. Google Play 및 결제 제공자의 거래 기록은 각 제공자의 정책에 따라 별도로 관리됩니다.</p>
<h2>4. 서비스 제공자와 SDK</h2>
<p>Google Firebase Authentication은 로그인, Google Play는 결제, Google ML Kit는 기기 내 얼굴 감지, Cloudflare Workers/D1은 구매 확인과 기록 보관에 사용됩니다. Google SDK는 해당 SDK의 정책에 따라 서비스 제공·안정성·진단에 필요한 앱·기기 관련 정보를 처리할 수 있습니다. 앱에는 광고 SDK나 직접 추가한 이용 분석·Crashlytics SDK가 없습니다.</p>
<p>Google과 Cloudflare의 서비스는 국외 인프라를 사용할 수 있습니다. 제공자의 처리 기준은 <a href="https://policies.google.com/privacy" rel="noreferrer">Google 개인정보처리방침</a>, <a href="https://firebase.google.com/support/privacy" rel="noreferrer">Firebase 개인정보 보호 안내</a>, <a href="https://developers.google.com/ml-kit/android-data-disclosure" rel="noreferrer">ML Kit 데이터 공개 안내</a>, <a href="https://www.cloudflare.com/privacypolicy/" rel="noreferrer">Cloudflare 개인정보처리방침</a>에서 확인할 수 있습니다.</p>
<h2>5. 보관과 삭제</h2>
<p>로그인 계정과 그 계정의 서버 구매 기록은 구매 확인과 복원을 제공하는 동안 보관합니다. 계정 및 연결된 데이터 삭제를 요청하면 운영자가 본인 확인과 처리 중인 구매 상태를 확인한 뒤 Firebase 계정, 서버에 연결된 구매·풀이 식별 정보 및 암호화된 구매 토큰을 삭제합니다.</p>
<p>삭제·취소된 구매의 재사용 방지를 위해 <strong>구매 토큰의 단방향 해시와 처리 시각은 서비스 운영 기간 동안 보관</strong>합니다. 이 기록에는 계정 식별자, 이메일, 원본 구매 토큰 또는 사진을 넣지 않습니다. 해시는 개인정보와 무관한 완전한 익명 정보라고 보장하지 않습니다.</p>
<p>삭제 요청 이메일과 답신은 본인 확인과 요청 처리에 필요한 동안 사용합니다. 기기에만 저장된 정보는 서버에서 원격으로 삭제할 수 없으므로 아래 안내에 따라 각 기기에서 별도로 지워야 합니다. 앱을 삭제하거나 로그아웃하는 것만으로 서버 계정은 삭제되지 않습니다.</p>
<h2>6. 삭제 요청과 문의</h2>
<p>앱의 <strong>계정 및 데이터 삭제 요청</strong> 메뉴 또는 로그인 없이 열 수 있는 <a href="/delete-account">계정 및 데이터 삭제 요청 페이지</a>를 이용하세요. 계정 전체 삭제 또는 특정 데이터 삭제 요청을 구분해 문의할 수 있습니다. 삭제 요청은 운영자가 확인 후 처리하며, 페이지를 열거나 이메일을 작성하는 것만으로 접수·삭제가 완료되지는 않습니다.</p>
<h2>7. 기기에 저장된 정보 삭제</h2>
<p>Android 설정 → 애플리케이션 → SOUL READER → 저장공간 → 데이터 삭제에서 앱의 로컬 기록과 캐시를 지울 수 있습니다. 사용 중인 모든 기기에서 각각 진행해야 합니다. 기기 내 풀이 기록을 지우면 구매 확인 서버에 구매 정보가 남아 있더라도 원래 사진과 풀이 내용이 복구되지 않을 수 있습니다.</p>
<h2>8. 보호 조치와 방침 변경</h2>
<p>구매 확인 통신에는 HTTPS를 사용하며 서버의 원본 구매 토큰은 암호화해 보관합니다. 인증·구매 토큰이나 비밀번호를 문의 이메일에 보내지 마세요. 처리 방식이 변경되면 이 페이지의 방침과 수정일을 갱신합니다.</p>`);

export const DELETE_ACCOUNT_PAGE = page('계정 및 데이터 삭제 요청', `
<p class="note">앱을 설치하거나 로그인하지 않고도 SOUL READER 계정과 연결된 데이터의 삭제를 요청할 수 있습니다. <strong>이 요청은 운영자가 이메일을 확인한 후 처리합니다.</strong></p>
<h2>1. 삭제 요청 보내기</h2>
<ol><li>SOUL READER 로그인에 사용한 Google 계정의 이메일에서 요청을 보내주세요.</li><li>받는 주소: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a><br>제목: <strong>[SOUL READER] 계정 및 데이터 삭제 요청</strong></li><li>본문에 앱 로그인에 사용한 이메일과 원하는 삭제 범위(계정 및 연결된 데이터 전체 / 특정 데이터)를 적어주세요.</li></ol>
<p><a class="button" href="${escape(mail)}">이메일 앱에서 삭제 요청 작성</a></p>
<p>이메일 앱이 열리지 않으면 위 주소와 제목을 복사해 이용하는 이메일 서비스에서 보내주세요. <strong>사진, 비밀번호, 인증 코드, 구매 토큰, 서비스 계정 키 또는 신분증은 보내지 마세요.</strong> 이 페이지는 입력 내용을 서버로 제출하지 않습니다. 이메일은 사용자가 직접 보내야 접수됩니다.</p>
<h2>2. 확인과 처리</h2>
<p>운영자가 로그인 계정의 이메일로 확인 답신을 보낼 수 있습니다. 본인 확인이나 처리 중인 구매 확인이 필요한 경우 추가 안내를 드립니다. 삭제가 끝나면 이메일로 처리 결과를 알려드립니다. 요청 작성 버튼을 누르는 것만으로 계정이 바로 삭제되지는 않습니다.</p>
<h2>3. 삭제되는 정보</h2>
<ul><li>SOUL READER의 Firebase 로그인 계정</li><li>해당 계정과 연결된 서버의 구매·구매 준비 기록 및 암호화한 원본 구매 토큰</li><li>해당 계정의 풀이 식별자, 주제 선택 정보와 서버 이용 제한 기록</li></ul>
<p>계정 삭제 후에는 기존 계정으로 구매 이용권을 확인하거나 복원할 수 없습니다. 삭제는 Google 계정 자체를 삭제하지 않으며, 환불을 자동으로 신청하지 않습니다. 환불은 Google Play의 주문·환불 절차를 별도로 이용하세요.</p>
<h2>4. 남는 정보와 보관 기간</h2>
<p>삭제·취소한 구매를 다시 사용할 수 없도록 <strong>구매 토큰의 단방향 해시와 처리 시각만 서비스 운영 기간 동안 보관</strong>합니다. 이 보안 기록에는 계정 식별자, 이메일, 원본 구매 토큰 또는 사진을 보관하지 않습니다. 해시는 완전한 익명 정보라고 보장하지 않습니다.</p>
<p>Google Play·Google·결제 제공자의 기록은 해당 제공자의 정책을 따르며, 이 앱의 계정 삭제 요청으로 함께 지워지지 않습니다.</p>
<h2>5. 기기에만 저장된 기록</h2>
<p>서버에서 휴대폰의 사진·풀이 기록을 원격으로 지울 수 없습니다. 각 Android 기기에서 <strong>설정 → 애플리케이션 → SOUL READER → 저장공간 → 데이터 삭제</strong>를 진행하면 로컬 앱 데이터를 지울 수 있습니다. 기기 내 풀이 기록을 지우면 원래 내용이 복구되지 않을 수 있습니다. 원래 갤러리 사진은 갤러리에서 직접 삭제해야 합니다.</p>`);

export function legalPageResponse(request) {
  const url = new URL(request.url);
  const content = url.pathname === '/privacy' ? PRIVACY_PAGE
    : url.pathname === '/delete-account' ? DELETE_ACCOUNT_PAGE : null;
  if (content === null) return null;
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  }
  return new Response(request.method === 'HEAD' ? null : content, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  } });
}
