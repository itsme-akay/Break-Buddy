# Break Buddies — Go-Live Checklist

## Verdict: Stage 1 kahan khada hai

Core product loop **poora kaam karta hai** — login, break create/join, live popups, accept/counter, chat, admin panel, real push notifications, aur data ab SQLite database mein safely store hota hai.

**Public / real users ke liye abhi launch mat karo.** Neeche 🔴 wale items safety aur legal risk hain — inke bina real strangers ke beech app chalana risky hai. (Tumhare kehne pe kuch items abhi ke liye skip kiye gaye hain — neeche note kiya hai.)

**Safe abhi ke liye:** ek closed group (dost, ek office/college) ke saath private link se test karo.

---

## ✅ Ho gaya

| Item | Status |
|---|---|
| Real push notifications (join request, accept, chat message) | ✅ Web Push + VAPID keys, `.env` mein set |
| JSON file → SQLite database | ✅ `breakbuddy.db`, atomic writes, crash-safe |
| Admin password `.env` se | ✅ Neeche "Admin panel" section mein details |
| Add to Home Screen (PWA) | ✅ Pehle se bana hua, manifest + service worker |

## Abhi ke liye jaanbujhke skip kiya (tumhare kehne pe)
- Report & Block
- Privacy Policy + Terms of Service page
- Real verification (OTP/email)
- Rate limiting
- Age notice

⚠️ **Ye sab tab tak theek hai jab tak app chhote/trusted group (dost, ek office) tak limited hai.** Jis din random strangers/public ko link doge, ye list dobara zaroori ho jayegi — tab bata dena, phir se prioritize kar denge.

---

## 🔴 Baaki bacha (jab bhi zaroorat ho)

| # | Item | Kyun zaroori hai |
|---|---|---|
| 1 | Report & Block user | Strangers milne wale app mein safety ke liye |
| 2 | Privacy Policy + Terms | Location + naam collect karte ho, legally chahiye jab public ho |
| 3 | Real verification | Impersonation se bachne ke liye |
| 4 | Rate limiting | Spam/fake accounts se bachne ke liye |
| 5 | Age notice (13+/18+) | Responsible launch ke liye |

## 🟡 Wider launch (Play Store type) se pehle
- **coke-icon.webp replace karo** — abhi bhi Coca-Cola jaisा dikhता hai, public launch pe trademark risk
- **Error monitoring** (Sentry free tier)
- **Basic analytics** (Plausible/GA)
- **Proper app icon/logo** (abhi coffee-cup placeholder hai)
- **iOS Safari real-device pass** — notification permission, "Add to Home Screen" flow
- **Data backup schedule** — `breakbuddy.db` ka daily backup

## 🟢 Baad mein
- Onboarding tutorial, referral system, streaks, group breaks

---

## Admin Panel — kaise kaam karta hai

**Link:** `https://tumhara-domain.com/admin` (abhi local: `http://localhost:3000/admin`)

**Login:** Browser ek native username/password popup dikhाएगा (HTTP Basic Auth) — koi custom login page nahi hai, browser khud maangता hai.
- Username: `.env` file mein `ADMIN_USER` (default `admin`)
- Password: `.env` file mein `ADMIN_PASS` (maine ek **strong random password generate karke `.env` mein daal diya hai**)

**Kaise kaam karta hai:**
1. Server start hote hi `.env` file se `ADMIN_USER`/`ADMIN_PASS` load hoti hai (`process.loadEnvFile()`)
2. `/admin` route pe jaते hi server check karta hai Authorization header — sahi na ho to `401` + browser popup
3. Sahi password dene pe live stats dikhते hain: total users, active breaks, meetups, push-notification-on users ka count, aur recent signups table
4. Har 30 sec auto-refresh hota hai

**Password badalna ho to:** `.env` file kholo (`breakbuddy-portal/.env`), `ADMIN_PASS=` ke aage naya password likho, server restart karo.

**⚠️ `.env` file kabhi git/GitHub pe commit mat karna** — `.gitignore` mein already add kar diya hai, safe hai.

---

## SEO Checklist (proper, structured)

### Zaroori context — SEO kahan lagegi
Break Buddies ka **app hi ka hissa** (map, breaks, chat) login ke peeche hai — Google isko crawl/index **kar hi nahi sakta**, aur karna bhi nahi chahiye (personal/location data hai). SEO ka **poora fayda ek public landing/marketing page ko milega** — jo app explain kare, waitlist le, ya download/install ka option de. Jab tak wo page nahi banता, SEO ka koi practical asar nahi hai.

### 1. Technical SEO (site-wide)
- [ ] **HTTPS** — non-negotiable, ranking signal + user trust (tumhare domain pe already set ho raha hai)
- [ ] **robots.txt** — abhi missing. Marketing/landing page allow, `/api/*`, `/admin`, aur app screens (`/` jab logged-in ho) disallow
- [ ] **sitemap.xml** — agar 2+ public pages ho (landing + privacy + terms)
- [ ] **Canonical tag** — duplicate content confusion se bachne ke liye
- [ ] **Mobile-first** — already hai (mobile-only design)
- [ ] **Page speed** — Lighthouse score 90+ target; images WebP/compressed, JS minimal blocking
- [ ] **`<meta name="robots" content="noindex">`** authenticated/app screens pe — accidental indexing se bachne ke liye
- [ ] **Structured data** — `schema.org/SoftwareApplication` ya `MobileApplication` markup, Google rich results ke liye

### 2. On-page SEO (landing page ban네 ke baad)
- [ ] **`<title>`** — unique, 50-60 chars, primary keyword ke saath (e.g. "Break Buddies — Meet Someone Nearby for a Quick Break")
- [ ] **`<meta name="description">`** — 150-160 chars, compelling, click karne ka reason de — abhi missing
- [ ] **Open Graph tags** (`og:title`, `og:description`, `og:image`, `og:url`, `og:type`) — WhatsApp/Facebook share preview ke liye
- [ ] **Twitter Card tags** (`twitter:card`, `twitter:title`, `twitter:image`)
- [ ] **Ek hi `<h1>`**, proper heading hierarchy (h1 → h2 → h3)
- [ ] **Alt text** har image pe
- [ ] **Favicon** multiple sizes (16x16, 32x32, apple-touch-icon) — apple-touch-icon already hai, wahi reuse hoga
- [ ] **Internal links** — landing page se privacy/terms/app links

### 3. Content / Keyword strategy
- [ ] Primary keyword decide karo: e.g. "meet nearby app", "spontaneous meetup app India", "break buddies app"
- [ ] Landing page copy mein naturally keywords use karo (title, first paragraph, headings) — keyword stuffing mat karo
- [ ] Blog/content angle (optional, baad mein) — "college break culture", "how to meet new people nearby" jaisa content organic traffic la sakta hai

### 4. Local SEO (kyunki ye location-based app hai)
- [ ] Google Business Profile bana sakte ho agar ek specific city/campus target karna hai
- [ ] City/area-specific landing pages agar multiple cities target karne hain (e.g. "Break Buddies Gurgaon")
- [ ] Local keywords: "nearby hangout app [city]"

### 5. Off-page / Launch day
- [ ] Google Search Console mein property register karo + sitemap submit
- [ ] Bing Webmaster Tools mein bhi register (kam traffic but free)
- [ ] Social profiles bana ke landing page link karo (Instagram, Twitter/X) — social signals + direct traffic
- [ ] Product Hunt / relevant India startup directories pe list karo (backlinks + early users)

### 6. Ongoing monitoring
- [ ] Search Console mein weekly check — kaunse queries se log aa rahe
- [ ] Core Web Vitals track karo (Search Console ya PageSpeed Insights)
- [ ] Broken links check periodically

---

## Infra / Hosting Checklist
- [x] Domain/subdomain + server tumhare paas hai — usी pe deploy hoga
- [ ] SSL certificate confirm karo (Hostinger free SSL, ya Cloudflare)
- [ ] Confirm Hostinger Node support hai (hPanel → "Setup Node.js App") — **zaroori: `better-sqlite3` native module hai, isliye Node version + build tools available hone chahiye hosting pe.** Agar dikkat aaye to Render/Railway pe migrate karna aasan hai.
- [ ] `.env` file server pe upload karo (khud, git se nahi — `.gitignore` mein hai)
- [ ] Process manager (PM2) ya hosting ka auto-restart, taaki crash pe app khud restart ho
- [ ] Uptime monitoring (UptimeRobot free tier)
- [ ] `breakbuddy.db` file ka regular backup (cron job se copy nikaalna simplest hai)

## Legal / Compliance Checklist (India-specific, jab public karo)
- [ ] Privacy Policy page
- [ ] Terms of Service page
- [ ] **COTPA compliance** — "smoke" break type tobacco jaisा dikh sakta hai. Neutral framing already hai, koi brand naam nahi hai — theek hai, lekin public launch pe legal se ek baar confirm karwa lena
- [ ] Data deletion request ka tarika

---

## Priority order (mera suggestion, jab public karna ho)
1. Admin password already set — ✅ done
2. Database already migrated — ✅ done
3. Push notifications already live — ✅ done
4. Closed beta (dost/office) ke saath abhi test karo — koi blocker nahi
5. Jab public/strangers ke liye kholna ho: 🔴 list (report/block, privacy policy, verification) pehle karna
6. Landing page + SEO — public launch ke saath
