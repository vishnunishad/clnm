const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');

// ─── Decide storage: R2 in production, local disk in development ───────────

const useR2 = process.env.NODE_ENV === 'production' &&
              process.env.R2_ACCOUNT_ID &&
              process.env.R2_ACCESS_KEY_ID &&
              process.env.R2_SECRET_KEY &&
              process.env.R2_BUCKET_NAME;

// ─── Cloudflare R2 Client ──────────────────────────────────────────────────

let r2Client;
if (useR2) {
  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_KEY,
    },
  });
}

// ─── File filter (same for both storages) ─────────────────────────────────

const fileFilter = (req, file, cb) => {
  const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF, JPG, PNG, and WEBP files are allowed.'));
  }
};

// ─── Storage: Cloudflare R2 ────────────────────────────────────────────────

const r2Storage = useR2
  ? multerS3({
      s3: r2Client,
      bucket: process.env.R2_BUCKET_NAME,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const customerId = req.params.customerId || 'general';
        const ext  = path.extname(file.originalname).toLowerCase();
        const base = path.basename(file.originalname, ext)
                         .replace(/\s+/g, '_')
                         .replace(/[^a-zA-Z0-9_-]/g, '');
        const key = `customer_${customerId}/${base}-${Date.now()}${ext}`;
        cb(null, key);
      },
      metadata: (req, file, cb) => {
        cb(null, { uploadedBy: String(req.user?.id || 'unknown') });
      },
    })
  : null;

// ─── Storage: Local Disk (development fallback) ────────────────────────────

const uploadsBase = path.join(__dirname, '..', 'uploads');
if (!useR2 && !fs.existsSync(uploadsBase)) {
  fs.mkdirSync(uploadsBase, { recursive: true });
}

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const customerId = req.params.customerId || 'general';
    const dir = path.join(uploadsBase, `customer_${customerId}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext)
                     .replace(/\s+/g, '_')
                     .replace(/[^a-zA-Z0-9_-]/g, '');
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});

// ─── Export multer instance ────────────────────────────────────────────────

const upload = multer({
  storage:    useR2 ? r2Storage : diskStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ─── Helper: get the public URL of an uploaded file ───────────────────────
// In R2: file.location is set by multer-s3 automatically.
// In local disk: build a path relative to /uploads.

upload.getFileUrl = (req, file) => {
  if (useR2) {
    // multer-s3 sets file.location to the full public R2 URL
    return file.location;
  }
  const customerId = req.params.customerId || 'general';
  return `/uploads/customer_${customerId}/${file.filename}`;
};

// ─── Helper: profile pictures ─────────────────────────────────────────────

const profilePicStorage = useR2
  ? multerS3({
      s3: r2Client,
      bucket: process.env.R2_BUCKET_NAME,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const ext  = path.extname(file.originalname).toLowerCase();
        const key  = `profile_pics/avatar_${req.user?.id || 'unknown'}_${Date.now()}${ext}`;
        cb(null, key);
      },
    })
  : multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(uploadsBase, 'profile_pics');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `avatar_${req.user?.id || 'unknown'}_${Date.now()}${ext}`);
      },
    });

const kycStorage = useR2
  ? multerS3({
      s3: r2Client,
      bucket: process.env.R2_BUCKET_NAME,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const key = `kyc_docs/kyc_${req.user?.id || 'unknown'}_doc_${Date.now()}${ext}`;
        cb(null, key);
      },
    })
  : multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(uploadsBase, 'kyc_docs');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `kyc_${req.user?.id || 'unknown'}_doc_${Date.now()}${ext}`);
      },
    });

upload.profilePic = multer({
  storage: profilePicStorage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
});

upload.kyc = multer({
  storage: kycStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

console.log(`File storage: ${useR2 ? 'Cloudflare R2 ☁️' : 'Local disk 💾'}`);

module.exports = upload;
