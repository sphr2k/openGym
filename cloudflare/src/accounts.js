import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from "@simplewebauthn/server";
import { json, jsonBody, randomBase64url } from "./protocol.js";

const DURATION = 90 * 86400000;
const CHALLENGE_TTL = 5 * 60000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const encode = s => new TextEncoder().encode(s);

function ownerPublic(u) {
  return { id: u.id, name: u.name, admin: !!u.admin, ...(u.owner ? { owner: true } : {}) };
}
function cleanName(raw) { return typeof raw === "string" ? raw.trim().slice(0, 40) : ""; }
function checkOrigin(request, env) {
  const url = new URL(request.url);
  return {
    origin: env.APP_ORIGIN || url.origin,
    rpID: env.RP_ID || new URL(env.APP_ORIGIN || url.origin).hostname,
    rpName: env.RP_NAME || "openGym"
  };
}
function valuesOfCookie(req, name) {
  return (req.headers.get("cookie") || "").split(";").flatMap(c => {
    const ix = c.indexOf("=");
    return ix !== -1 && c.slice(0, ix).trim() === name ? [c.slice(ix + 1).trim()] : [];
  });
}
function authToken(req) {
  for (const name of ["__Host-gymsid", "gymsid"]) {
    const values = valuesOfCookie(req, name);
    if (values.length) {
      if (values.some(x => x !== values[0])) return { badCookie: true };
      return { token: values[0], bearer: false };
    }
  }
  const auth = req.headers.get("authorization") || "";
  return { token: auth.startsWith("Bearer ") ? auth.slice(7).trim() : "", bearer: true };
}
function cookieHeaders(token, origin) {
  const secure = origin.startsWith("https://");
  const name = secure ? "__Host-gymsid" : "gymsid";
  return { "Set-Cookie": name + "=" + token + "; Path=/; Max-Age=" +
    Math.floor(DURATION / 1000) + "; HttpOnly; " + (secure ? "Secure; " : "") + "SameSite=Lax" };
}

export class AccountDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,created TEXT NOT NULL,sv INTEGER NOT NULL DEFAULT 0,disabled INTEGER NOT NULL DEFAULT 0,admin INTEGER NOT NULL DEFAULT 0,owner INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,public_key TEXT NOT NULL,counter INTEGER NOT NULL,transports TEXT NOT NULL,created TEXT NOT NULL,last_used TEXT NOT NULL,name TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS pairings(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,n INTEGER NOT NULL,started INTEGER NOT NULL)");
    if (!this.sql.exec("SELECT value FROM meta WHERE key='session_key'").toArray()[0]) {
      this.sql.exec("INSERT OR IGNORE INTO meta(key,value) VALUES ('session_key', ?)", randomBase64url(32));
    }
  }

  queryOne(sql, ...params) { return this.sql.exec(sql, ...params).toArray()[0] || null; }

  async key() {
    if (this._key) return this._key;
    const b64 = this.queryOne("SELECT value FROM meta WHERE key='session_key'").value;
    this._key = await crypto.subtle.importKey("raw", Buffer.from(b64, "base64url"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    return this._key;
  }

  async sign(user, kind = "b") {
    const payload = [user.id, Date.now() + DURATION, user.sv, kind].join(":");
    const sig = await crypto.subtle.sign("HMAC", await this.key(), encode(payload));
    return payload + "." + Buffer.from(sig).toString("base64url");
  }

  async authenticate(req) {
    const candidate = authToken(req);
    if (!candidate.token || candidate.badCookie) return null;
    const i = candidate.token.lastIndexOf(".");
    if (i <= 0) return null;
    const payload = candidate.token.slice(0, i);
    const mac = candidate.token.slice(i + 1);
    let bytes;
    try { bytes = Buffer.from(mac, "base64url"); } catch { return null; }
    if (bytes.length !== 32 || !await crypto.subtle.verify("HMAC", await this.key(), bytes, encode(payload))) return null;
    const [uid, expiry, version, kind] = payload.split(":");
    const exp = Number(expiry);
    if (!uid || !Number.isFinite(exp) || exp < Date.now()) return null;
    const user = this.queryOne("SELECT * FROM users WHERE id=?", uid);
    if (!user || user.disabled || Number(version) !== user.sv) return null;
    if (candidate.bearer && kind !== "b") return null;
    return { user, exp, bearer: candidate.bearer, kind };
  }

  rateLimit(req, category, limit = 12) {
    const ip = req.headers.get("cf-connecting-ip") || "local";
    const id = category + ":" + ip;
    const now = Date.now();
    const r = this.queryOne("SELECT n,started FROM attempts WHERE id=?", id);
    if (!r || now - r.started >= 60000) {
      this.sql.exec("INSERT INTO attempts(id,n,started) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET n=excluded.n,started=excluded.started", id, 1, now);
      return false;
    }
    this.sql.exec("UPDATE attempts SET n=n+1 WHERE id=?", id);
    return r.n >= limit;
  }

  putTicket(kind, payload) {
    const id = randomBase64url(16);
    this.sql.exec("DELETE FROM tickets WHERE expires<?", Date.now());
    this.sql.exec("INSERT INTO tickets(id,kind,payload,expires) VALUES (?,?,?,?)", id, kind, JSON.stringify(payload), Date.now() + CHALLENGE_TTL);
    return id;
  }

  takeTicket(id, kind) {
    if (typeof id !== "string") return null;
    return this.ctx.storage.transactionSync(() => {
      const row = this.queryOne("SELECT kind,payload,expires FROM tickets WHERE id=?", id);
      this.sql.exec("DELETE FROM tickets WHERE id=?", id);
      if (!row || row.kind !== kind || row.expires < Date.now()) return null;
      return JSON.parse(row.payload);
    });
  }

  async verifyAssertion(body, ticket, userId, rp) {
    const credential = this.queryOne("SELECT * FROM credentials WHERE id=?", body.credential?.id);
    if (!credential || (userId && credential.user_id !== userId)) return null;
    try {
      const answer = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: ticket.challenge,
        expectedOrigin: rp.origin, expectedRPID: rp.rpID,
        requireUserVerification: false,
        credential: {
          id: credential.id, publicKey: Buffer.from(credential.public_key, "base64url"),
          counter: credential.counter,
          transports: JSON.parse(credential.transports)
        }
      });
      if (!answer.verified) return null;
      const now = new Date().toISOString();
      this.sql.exec("UPDATE credentials SET counter=?, last_used=? WHERE id=?", answer.authenticationInfo.newCounter, now, credential.id);
      return this.queryOne("SELECT * FROM users WHERE id=?", credential.user_id);
    } catch { return null; }
  }

  async codeHash(code) {
    const digest = await crypto.subtle.digest("SHA-256", encode("opengym-pair:" + code));
    return Buffer.from(digest).toString("hex");
  }

  async respond(req) {
    const path = new URL(req.url).pathname;
    const method = req.method;
    const route = method + " " + path;
    const rp = checkOrigin(req, this.env);
    let body = {};
    if (["POST","PUT","PATCH","DELETE"].includes(method)) {
      const parsed = await jsonBody(req);
      if (parsed.error) return parsed.error;
      body = parsed.value;
    }
    if (route === "POST /_internal/resolve") {
      const s = await this.authenticate(req);
      return s ? json({ id: s.user.id, user: ownerPublic(s.user), bearer: s.bearer, kind: s.kind, exp: s.exp }) : json({ error: "not signed in" }, 401);
    }
    if (route === "GET /_internal/health") {
      const row = this.queryOne("SELECT COUNT(*) AS n FROM users");
      const last = Number(this.queryOne("SELECT value FROM meta WHERE key='last_health'")?.value || 0);
      if (Date.now() - last >= 5000) {
        this.sql.exec("INSERT INTO meta(key,value) VALUES ('last_health', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(Date.now()));
      }
      return json({ ok: true, users: row.n, writable: true });
    }
    if (route === "POST /api/register/options") {
      if (this.rateLimit(req,"register",15)) return json({ error: "too many attempts" },429);
      const name = cleanName(body.name);
      if (!name) return json({ error: "name required" },400);
      if (this.queryOne("SELECT id FROM users WHERE name=?",name)) return json({error:"name already taken"},409);
      const uid = randomBase64url(12);
      const options = await generateRegistrationOptions({
        rpName:rp.rpName, rpID:rp.rpID, userID:encode(uid),
        userName:name, userDisplayName:name, attestationType:"none",
        authenticatorSelection:{residentKey:"required",userVerification:"preferred"}, excludeCredentials:[]
      });
      const cid = this.putTicket("register",{challenge:options.challenge,name,uid});
      return json({cid,options});
    }
    if (route === "POST /api/register/verify") {
      if (this.rateLimit(req,"register-verify",12)) return json({error:"too many attempts"},429);
      const t = this.takeTicket(body.cid,"register");
      if (!t) return json({error:"challenge expired, try again",code:"challenge-expired"},400);
      let answer;
      try {
        answer = await verifyRegistrationResponse({
          response:body.credential,expectedChallenge:t.challenge,
          expectedOrigin:rp.origin,expectedRPID:rp.rpID,requireUserVerification:false
        });
      } catch { return json({error:"passkey verification failed",code:"verify-error"},400); }
      if (!answer.verified) return json({error:"not verified"},400);
      const key = answer.registrationInfo.credential;
      let user;
      try {
        user = this.ctx.storage.transactionSync(() => {
          if (this.queryOne("SELECT id FROM credentials WHERE id=?",key.id) ||
              this.queryOne("SELECT id FROM users WHERE name=?",t.name)) return null;
          const created = new Date().toISOString();
          const total = this.queryOne("SELECT COUNT(*) AS n FROM users").n;
          const admin = total === 0 && /^(1|true|yes|on)$/i.test(String(this.env.FIRST_USER_ADMIN || ""));
          this.sql.exec("INSERT INTO users(id,name,created,admin,owner) VALUES (?,?,?,?,?)",
            t.uid,t.name,created,admin ? 1 : 0,admin ? 1 : 0);
          this.sql.exec("INSERT INTO credentials(id,user_id,public_key,counter,transports,created,last_used) VALUES (?,?,?,?,?,?,?)",
            key.id,t.uid,Buffer.from(key.publicKey).toString("base64url"),key.counter||0,
            JSON.stringify(body.credential?.response?.transports || []),created,created);
          return this.queryOne("SELECT * FROM users WHERE id=?",t.uid);
        });
      } catch { return json({error:"account could not be created"},409); }
      if (!user) return json({error:"credential or name already registered"},409);
      const token = await this.sign(user,"c");
      return json({user:ownerPublic(user)},200,cookieHeaders(token,rp.origin));
    }
    if (route === "POST /api/login/options") {
      if (this.rateLimit(req,"login",24)) return json({error:"too many attempts"},429);
      const options = await generateAuthenticationOptions({
        rpID:rp.rpID,userVerification:"preferred",allowCredentials:[]
      });
      const cid = this.putTicket("login",{challenge:options.challenge});
      return json({cid,options});
    }
    if (route === "POST /api/login/verify") {
      if (this.rateLimit(req,"login-verify",20)) return json({error:"too many attempts"},429);
      const t = this.takeTicket(body.cid,"login");
      if (!t) return json({error:"challenge expired, try again",code:"challenge-expired"},400);
      const user = await this.verifyAssertion(body,t,null,rp);
      if (!user || user.disabled) return json({error:"passkey could not be verified"},403);
      return json({user:ownerPublic(user)},200,cookieHeaders(await this.sign(user,"c"),rp.origin));
    }
    if (route === "POST /api/pair/redeem") {
      if (this.rateLimit(req,"pair-redeem",20)) return json({error:"too many attempts"},429);
      const code = String(body.code || "").trim().toUpperCase();
      const hash = await this.codeHash(code);
      const p = this.ctx.storage.transactionSync(() => {
        const row = this.queryOne("SELECT user_id,expires FROM pairings WHERE code_hash=?",hash);
        this.sql.exec("DELETE FROM pairings WHERE code_hash=?",hash);
        return row && row.expires >= Date.now() ? row : null;
      });
      const user = p && this.queryOne("SELECT * FROM users WHERE id=?",p.user_id);
      if (!user || user.disabled) return json({error:"invalid or expired code",code:"pair-invalid"},400);
      return json({token:await this.sign(user,"b"),user:ownerPublic(user)});
    }

    const s = await this.authenticate(req);
    if (!s) return json({error:"not signed in"},401);

    if (route === "GET /api/me") {
      const renew = s.bearer && s.kind === "b" && s.exp - Date.now() < DURATION/2;
      return json({user:ownerPublic(s.user),...(renew ? {token:await this.sign(s.user,"b")} : {})});
    }
    if (route === "GET /api/account/passkeys") {
      const rows = this.sql.exec("SELECT id,name,created,last_used AS lastUsed,transports FROM credentials WHERE user_id=? ORDER BY created",s.user.id).toArray();
      return json({passkeys:rows.map(x=>({id:x.id,name:x.name||null,created:x.created,lastUsed:x.lastUsed,transports:JSON.parse(x.transports)})),password:false,lastWayIn:rows.length<=1});
    }
    if (route === "POST /api/pair/create") {
      // Do NOT mint an indefinite mobile bearer token from a stolen cookie alone.
      const t = this.takeTicket(body.cid,"login");
      if (!t || !body.credential) return json({error:"confirm with your passkey first",code:"passkey-required"},403);
      const verified = await this.verifyAssertion(body,t,s.user.id,rp);
      if (!verified) return json({error:"the passkey could not be verified",code:"passkey"},403);
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const code = Array.from(bytes,b=>CODE_ALPHABET[b%CODE_ALPHABET.length]).join("");
      const hash = await this.codeHash(code);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM pairings WHERE user_id=?",s.user.id);
        this.sql.exec("INSERT INTO pairings(code_hash,user_id,expires) VALUES (?,?,?)",hash,s.user.id,Date.now()+CHALLENGE_TTL);
      });
      return json({code});
    }
    if (route === "POST /api/logout") {
      const name = rp.origin.startsWith("https://") ? "__Host-gymsid" : "gymsid";
      return json({ok:true},200,{"Set-Cookie":name+"=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"});
    }
    if (route === "POST /api/logout/all") {
      this.sql.exec("UPDATE users SET sv=sv+1 WHERE id=?",s.user.id);
      this.sql.exec("DELETE FROM pairings WHERE user_id=?",s.user.id);
      const name = rp.origin.startsWith("https://") ? "__Host-gymsid" : "gymsid";
      return json({ok:true},200,{"Set-Cookie":name+"=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"});
    }
    return json({error:"not found"},404);
  }

  async fetch(req) {
    try { return await this.respond(req); }
    catch (error) {
      console.error("AccountDO request failed",error);
      return json({error:"internal error"},500);
    }
  }
}
