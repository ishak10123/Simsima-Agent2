import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import twitterText from 'twitter-text';
import { AppError } from './errors.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function normalizeAccount(value) {
  if (typeof value !== 'string' || !/^@?[A-Za-z0-9_]{1,15}$/.test(value)) {
    throw new AppError('invalid_account', 'حدد اسم حساب X مثل @your_account.');
  }
  return value.replace(/^@/, '').toLowerCase();
}

export function normalizeText(value) {
  return value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

export function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AppError('invalid_text', 'نص المنشور مطلوب.');
  const normalized = normalizeText(text);
  const parsed = twitterText.parseTweet(normalized);
  if (!parsed.valid) {
    throw new AppError('invalid_text', 'النص غير صالح لمنشور عادي على X (الحد 280 حرفًا موزونًا).', {
      weightedLength: parsed.weightedLength, maxWeightedLength: 280,
    });
  }
  return { text: normalized, weightedLength: parsed.weightedLength };
}

export function normalizeYouTubeChannel(value) {
  if (typeof value !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new AppError('invalid_channel', 'حدد معرّف قناة YouTube الذي تعيده أداة فحص القناة.');
  }
  return value;
}

export function validateYouTubeText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AppError('invalid_text', 'نص المنشور مطلوب.');
  const normalized = normalizeText(text);
  const length = [...normalized].length;
  if (length > 1000) throw new AppError('invalid_text', 'النسخة الأولى لمنشورات YouTube تدعم حتى 1000 حرف.');
  return { text: normalized, weightedLength: length };
}

export function normalizeDiscordChannel(value) {
  if (typeof value !== 'string' || !/^[0-9]{17,20}$/.test(value)) {
    throw new AppError('invalid_channel', 'حدد معرّف قناة Discord الذي يعيده فحص Webhook.');
  }
  return value;
}

export function validateDiscordText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AppError('invalid_text', 'نص المنشور مطلوب.');
  const normalized = normalizeText(text);
  if (normalized.length > 2000) throw new AppError('invalid_text', 'الحد الأقصى لنص Discord هو 2000 حرف.');
  return { text: normalized, weightedLength: normalized.length };
}

export async function readImage(imagePath) {
  if (!imagePath) return null;
  const path = resolve(imagePath);
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) {
      throw new AppError('invalid_image', 'اختر صورة PNG أو JPEG لا تتجاوز 5 MiB.');
    }
    // Read a bounded snapshot, including one byte to detect growth since stat().
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) throw new AppError('image_changed', 'تغير ملف الصورة أثناء قراءته. أعد تجهيز المسودة.');
    const bytes = buffer.subarray(0, length);
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) throw new AppError('invalid_image', 'النسخة الأولى تدعم PNG وJPEG فقط.');
    return {
      name: basename(path), uploadName: png ? 'image.png' : 'image.jpg',
      mimeType: png ? 'image/png' : 'image/jpeg', bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('image_unreadable', 'تعذر قراءة الصورة المطلوبة؛ لم تُنشأ المسودة.', { name: basename(path) });
  } finally { await file?.close(); }
}
