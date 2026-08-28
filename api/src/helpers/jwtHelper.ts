import jwt, { JwtPayload, Secret, SignOptions } from 'jsonwebtoken';

const createToken = (payload: object, secret: Secret, expireTime: string) => {
    const options: SignOptions = { expiresIn: expireTime as SignOptions['expiresIn'], algorithm: 'HS256' };
    return jwt.sign(payload, secret, options);
};

// Pass 19 — Security Hardening. `jwt.verify` without an explicit `algorithms`
// allowlist trusts whatever algorithm the token's own header claims. This app only
// ever signs with a symmetric secret (HS256 — see createToken above), so the classic
// "RS256-to-HS256 confusion" attack (using a known public key as an HMAC secret) was
// never directly reachable here since no public key is ever exposed — but pinning the
// algorithm explicitly is still the correct, defense-in-depth baseline (OWASP's JWT
// guidance), rather than relying on there being no other exploitable path today.
const verifyToken = (token: string, secret: Secret): JwtPayload => {
    return jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload
}

export const JwtHelper = {
    verifyToken,
    createToken
}