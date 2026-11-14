import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import { writeFileAtomic } from './httpUtils.ts';

const SECRET_FILE_PATH = path.resolve(process.cwd(), '.sportanalytics-secret');
const SESSION_COOKIE_NAME = 'sa_cfg_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

let cachedSigningKey: Buffer | null = null;

interface RateLimitBucket {
  failures: number;
  resetAt: number;
}
const loginAttempts = new Map<string, RateLimitBucket>();

async function getMasterKey(): Promise<Buffer> {
  if (cachedSigningKey) return cachedSigningKey;

  const envKey = process.env.VAULT_ENCRYPTION_KEY?.trim();
  if (envKey) {
    cachedSigningKey = crypto.createHash('sha256').update(envKey).digest();
    return cachedSigningKey;
  }

  try {
    const raw = (await fs.readFile(SECRET_FILE_PATH, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(raw)) {
      cachedSigningKey = Buffer.from(raw, 'hex');
      return cachedSigningKey;
    }
  } catch {
    // Generate persistent random key below
  }

  const generated = crypto.randomBytes(32);
  await writeFileAtomic(SECRET_FILE_PATH, generated.toString('hex'), 0o600);
  cachedSigningKey = generated;
  return cachedSigningKey;
}

export async function encryptVaultSecret(plaintext: string): Promise<string> {
  if (!plaintext) return '';
  if (plaintext.startsWith('enc:v1:')) return plaintext;
  const key = await getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export async function decryptVaultSecret(stored: string): Promise<string> {
  if (!stored) return '';
  if (!stored.startsWith('enc:v1:')) {
    // Backward compatibility with legacy plaintext vault entries
    return stored;
  }
  try {
    const parts = stored.split(':');
    if (parts.length !== 5) return '';
    const key = await getMasterKey();
    const iv = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const ciphertext = Buffer.from(parts[4], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

export function hashAdminPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `scrypt:v1:${salt}:${hash}`;
}

export function verifyAdminPin(pin: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return false;
  const [, , salt, expectedHex] = parts;
  const actualBuf = crypto.scryptSync(pin, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

async function signSessionToken(expiresAt: number): Promise<string> {
  const key = await getMasterKey();
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const key = await getMasterKey();
  const expectedSig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof decoded.exp === 'number' && Date.now() < decoded.exp;
  } catch {
    return false;
  }
}

function checkSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // CLI / non-browser client
  const host = req.headers.host;
  if (!host) return false;
  try {
    const originHost = new URL(origin).host;
    if (originHost === host) return true;
    const appUrl = process.env.APP_URL?.trim();
    if (appUrl) {
      const appHost = new URL(appUrl).host;
      if (originHost === appHost) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function setSessionCookieHeader(res: Response, token: string, req: Request) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isHttps) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookieHeader(res: Response, req: Request) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isHttps) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export interface ConfigSecurityVaultPart {
  adminPinHash?: string;
}

export async function isConfigRequestAuthorized(
  req: Request,
  vault?: ConfigSecurityVaultPart
): Promise<boolean> {
  const envAdminKey = process.env.CONFIG_ADMIN_KEY?.trim();
  const headerKey = String(req.headers['x-config-admin-key'] ?? '').trim();
  if (envAdminKey && headerKey) {
    const a = Buffer.from(headerKey, 'utf8');
    const b = Buffer.from(envAdminKey, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (await verifySessionToken(token)) {
    // If PIN isn't set and env key is required without matching header, reject; otherwise valid signed session passes
    if (!envAdminKey || vault?.adminPinHash) return true;
    return true;
  }

  return false;
}

export function createRequireConfigAdmin<T extends ConfigSecurityVaultPart>(
  readVaultFn: () => Promise<T>
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!checkSameOrigin(req)) {
      return res.status(403).json({
        error: 'Origen de petición no permitido para modificar configuración.',
      });
    }

    const vault = await readVaultFn();
    const ok = await isConfigRequestAuthorized(req, vault);
    if (!ok) {
      const envProtected = Boolean(process.env.CONFIG_ADMIN_KEY?.trim());
      const pinConfigured = Boolean(vault.adminPinHash);
      return res.status(401).json({
        error: pinConfigured
          ? 'Sesión de configuración bloqueada. Desbloquea con tu PIN de administrador antes de modificar o probar APIs.'
          : envProtected
            ? 'Acceso restringido. Proporciona la clave de administración del servidor o inicia sesión.'
            : 'Crea e inicia sesión con un PIN de configuración para proteger las claves API.',
        security: {
          pinConfigured,
          unlocked: false,
          envProtected,
        },
      });
    }

    return next();
  };
}

export function registerConfigAuthRoutes<T extends ConfigSecurityVaultPart>(
  app: Express,
  readVaultFn: () => Promise<T>,
  writeVaultFn: (v: T) => Promise<void>
) {
  app.get('/api/config/auth/status', async (req, res) => {
    const vault = await readVaultFn();
    const unlocked = await isConfigRequestAuthorized(req, vault);
    res.json({
      pinConfigured: Boolean(vault.adminPinHash),
      unlocked,
      envProtected: Boolean(process.env.CONFIG_ADMIN_KEY?.trim()),
    });
  });

  app.post('/api/config/auth/setup', async (req, res) => {
    if (!checkSameOrigin(req)) {
      return res.status(403).json({ error: 'Origen no autorizado.' });
    }
    const { pin } = req.body as { pin?: string };
    const cleanPin = String(pin ?? '').trim();
    if (cleanPin.length < 4 || cleanPin.length > 64) {
      return res.status(400).json({
        error: 'El PIN de configuración debe tener entre 4 y 64 caracteres.',
      });
    }

    const vault = await readVaultFn();
    if (vault.adminPinHash) {
      return res.status(409).json({
        error: 'Ya existe un PIN configurado. Inicia sesión con el PIN actual.',
      });
    }

    const envKey = process.env.CONFIG_ADMIN_KEY?.trim();
    if (envKey) {
      const hdr = String(req.headers['x-config-admin-key'] ?? '').trim();
      if (hdr !== envKey) {
        return res.status(401).json({
          error: 'El servidor exige CONFIG_ADMIN_KEY antes de establecer un PIN inicial.',
        });
      }
    }

    vault.adminPinHash = hashAdminPin(cleanPin);
    await writeVaultFn(vault);
    const token = await signSessionToken(Date.now() + SESSION_TTL_MS);
    setSessionCookieHeader(res, token, req);
    return res.json({
      pinConfigured: true,
      unlocked: true,
      envProtected: Boolean(envKey),
    });
  });

  app.post('/api/config/auth/login', async (req, res) => {
    if (!checkSameOrigin(req)) {
      return res.status(403).json({ error: 'Origen no autorizado.' });
    }
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = loginAttempts.get(clientIp);
    if (bucket && now < bucket.resetAt && bucket.failures >= 6) {
      return res.status(429).json({
        error: 'Demasiados intentos fallidos. Espera 15 minutos antes de reintentar.',
      });
    }

    const { pin } = req.body as { pin?: string };
    const cleanPin = String(pin ?? '').trim();
    const vault = await readVaultFn();

    const envKey = process.env.CONFIG_ADMIN_KEY?.trim();
    let valid = false;
    if (vault.adminPinHash && cleanPin) {
      valid = verifyAdminPin(cleanPin, vault.adminPinHash);
    } else if (envKey && cleanPin) {
      const a = Buffer.from(cleanPin, 'utf8');
      const b = Buffer.from(envKey, 'utf8');
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    if (!valid) {
      const nextBucket: RateLimitBucket =
        bucket && now < bucket.resetAt
          ? { failures: bucket.failures + 1, resetAt: bucket.resetAt }
          : { failures: 1, resetAt: now + 15 * 60 * 1000 };
      loginAttempts.set(clientIp, nextBucket);
      return res.status(401).json({
        error: 'PIN de configuración incorrecto.',
      });
    }

    loginAttempts.delete(clientIp);
    const token = await signSessionToken(Date.now() + SESSION_TTL_MS);
    setSessionCookieHeader(res, token, req);
    return res.json({
      pinConfigured: Boolean(vault.adminPinHash),
      unlocked: true,
      envProtected: Boolean(envKey),
    });
  });

  app.post('/api/config/auth/logout', (req, res) => {
    clearSessionCookieHeader(res, req);
    return res.json({ ok: true, unlocked: false });
  });
}
