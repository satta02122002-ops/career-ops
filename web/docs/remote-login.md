# Optional login and remote access

The dashboard has no login by default: it binds loopback and the bind is the
access control. To reach it from your own domain, turn on the optional login
and publish it through a tunnel. Never publish it without the login.

## 1. Turn on the login

```bash
cd web
npm run auth:hash            # asks for a password (12+ characters), input hidden
```

It prints two lines. Put them in `web/.env.local` (gitignored) or in the service's
environment file:

```
CAREER_OPS_WEB_PASSWORD_HASH=scrypt:...
CAREER_OPS_WEB_SESSION_SECRET=...
```

Optional: `CAREER_OPS_WEB_SESSION_TTL_SECONDS` (default 604800, 7 days) and
`CAREER_OPS_WEB_COOKIE_SECURE=1` to force Secure cookies.

With the hash set, every page and `/api` route needs a signed session cookie
(HttpOnly, SameSite=Strict, Secure over HTTPS). Pages redirect to `/login`,
`/api` answers 401. Five wrong passwords lock that client address for 15
minutes. If the hash is set but the secret is missing or shorter than 32
characters, every route answers 503 rather than serving unauthenticated.

To change the password, run `npm run auth:hash` again and restart. A new
secret also signs out every existing session.

## 2. Publish with Cloudflare Tunnel

Keep the server on loopback and let `cloudflared` carry traffic in, so no port
is opened on the machine. In the tunnel's ingress rule, rewrite the Host header
to the loopback name the request guard already accepts:

```yaml
ingress:
  - hostname: jobs.example.com
    service: http://localhost:3000
    originRequest:
      httpHostHeader: localhost:3000
  - service: http_status:404
```

Cloudflare sets `X-Forwarded-Proto: https` and `CF-Connecting-IP`, which the
login uses for Secure cookies and per-client lockout. Optionally put Cloudflare
Access in front of the hostname as a second layer.
