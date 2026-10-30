import { BadRequestException } from '@nestjs/common';
import { memoryStorage } from 'multer';
export const inquiryUploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 0 },
};
export function attachmentInput(file: Express.Multer.File) {
  const b = file.buffer;
  if (!b?.length || b.length > 5 * 1024 * 1024)
    throw new BadRequestException(
      'Each attachment must be between 1 byte and 5 MB',
    );
  const mime =
    b.subarray(0, 5).toString() === '%PDF-'
      ? 'application/pdf'
      : b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : b[0] === 255 && b[1] === 216 && b[2] === 255
          ? 'image/jpeg'
          : /^GIF8[79]a/.test(b.subarray(0, 6).toString())
            ? 'image/gif'
            : b.subarray(0, 4).toString() === 'RIFF' &&
                b.subarray(8, 12).toString() === 'WEBP'
              ? 'image/webp'
              : null;
  if (!mime)
    throw new BadRequestException(
      'Attachments must be PDF, PNG, JPEG, GIF or WebP files',
    );
  const name =
    (file.originalname.replace(/\\/g, '/').split('/').pop() || 'attachment')
      .split('')
      .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
      .join('')
      .slice(0, 150) || 'attachment';
  return { name, mime, size: b.length, data: b };
}
