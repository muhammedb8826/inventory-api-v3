import { BadRequestException } from '@nestjs/common';
import { memoryStorage } from 'multer';
import type { Options } from 'multer';

const IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const EXCEL_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream', // some browsers/OS send this for .xlsx
]);

const EXCEL_EXT = /\.(xlsx|xls)$/i;

export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const EXCEL_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

function fileFilter(
  allowed: (file: Express.Multer.File) => boolean,
  message: string,
): NonNullable<Options['fileFilter']> {
  return (_req, file, cb) => {
    if (!allowed(file)) {
      // Multer reject overload: callback(error) — Nest maps HttpException to 400
      cb(new BadRequestException(message) as unknown as Error);
      return;
    }
    cb(null, true);
  };
}

/** Memory storage + size/MIME limits for item/branding images. */
export const imageUploadOptions: Options = {
  storage: memoryStorage(),
  limits: { fileSize: IMAGE_UPLOAD_MAX_BYTES, files: 1 },
  fileFilter: fileFilter(
    (f) => IMAGE_MIME.has(f.mimetype),
    'Image must be JPEG, PNG, WebP, or GIF',
  ),
};

/** Memory storage + size/MIME limits for inventory Excel import. */
export const excelUploadOptions: Options = {
  storage: memoryStorage(),
  limits: { fileSize: EXCEL_UPLOAD_MAX_BYTES, files: 1 },
  fileFilter: fileFilter((f) => {
    if (EXCEL_MIME.has(f.mimetype)) return true;
    return EXCEL_EXT.test(f.originalname ?? '');
  }, 'File must be an Excel workbook (.xlsx or .xls)'),
};
