/**
 * Rate Limiting Middleware
 * Prevents brute force attacks and DoS
 */

const rateLimitStore = new Map();

const getRateLimit = () => ({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '5') // 5 attempts
});

/**
 * Simple in-memory rate limiter
 * For production, use redis-based solution
 */
const rateLimit = (identifier, options = getRateLimit()) => {
  const now = Date.now();
  const key = identifier;

  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, { count: 1, resetTime: now + options.windowMs });
    return { allowed: true, remaining: options.maxRequests - 1, resetTime: now + options.windowMs };
  }

  const record = rateLimitStore.get(key);

  if (now > record.resetTime) {
    // Window has expired, reset
    rateLimitStore.set(key, { count: 1, resetTime: now + options.windowMs });
    return { allowed: true, remaining: options.maxRequests - 1, resetTime: now + options.windowMs };
  }

  record.count++;
  const allowed = record.count <= options.maxRequests;
  const remaining = Math.max(0, options.maxRequests - record.count);

  return { allowed, remaining, resetTime: record.resetTime };
};

/**
 * Login Rate Limiter Middleware
 * Login lockout has been intentionally disabled.
 * Users may retry immediately on failed credentials.
 */
const loginLimiter = (req, res, next) => {
  next();
};

/**
 * Password reset request limiter
 * Slightly looser than login, but still protects the mailbox.
 */
const forgotPasswordLimiter = (req, res, next) => {
  const identifier = `forgot-password:${req.ip}:${req.body?.email || 'unknown'}`;
  const limit = rateLimit(identifier, {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 3 // 3 requests per hour
  });

  res.setHeader('RateLimit-Limit', limit.maxRequests || 3);
  res.setHeader('RateLimit-Remaining', Math.max(0, limit.remaining || 0));
  res.setHeader('RateLimit-Reset', new Date(limit.resetTime).toISOString());

  if (!limit.allowed) {
    return res.status(429).json({
      success: false,
      message: `Too many password reset requests. Please try again after ${new Date(limit.resetTime).toLocaleTimeString()}.`,
      retryAfter: Math.ceil((limit.resetTime - Date.now()) / 1000)
    });
  }

  next();
};

/**
 * API General Rate Limiter
 * Moderate rate limiting for general API usage
 */
const apiLimiter = (req, res, next) => {
  // Skip rate limiting for static files and uploads
  if (req.path.startsWith('/uploads') || req.path.match(/\.(js|css|json|png|jpg|jpeg|gif|svg)$/i)) {
    return next();
  }

  const identifier = `api:${req.ip}`;
  const limit = rateLimit(identifier, {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100 // 100 requests per minute
  });

  if (!limit.allowed) {
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please try again later.',
      retryAfter: Math.ceil((limit.resetTime - Date.now()) / 1000)
    });
  }

  next();
};

/**
 * Cleanup expired entries (run periodically)
 */
const cleanupRateLimitStore = () => {
  const now = Date.now();
  const expired = Array.from(rateLimitStore.entries())
    .filter(([_, record]) => now > record.resetTime)
    .map(([key]) => key);

  expired.forEach(key => rateLimitStore.delete(key));

  if (expired.length > 0) {
    console.log(`[RateLimit] Cleaned up ${expired.length} expired entries`);
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupRateLimitStore, 5 * 60 * 1000);

module.exports = {
  loginLimiter,
  forgotPasswordLimiter,
  apiLimiter,
  rateLimit,
  getRateLimit
};
