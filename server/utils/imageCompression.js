import sharp from 'sharp';

/**
 * Smart image compression optimized for text readability
 * Detects screenshots and applies appropriate compression strategies
 * 
 * @param {Buffer} buffer - Original image buffer
 * @param {string} mimeType - MIME type (image/jpeg, image/png, etc.)
 * @param {number} maxSize - Target maximum file size in bytes (default: 10MB)
 * @returns {Promise<{buffer: Buffer, compressed: boolean, originalSize: number, finalSize: number}>}
 */
export async function compressImageIfNeeded(buffer, mimeType, maxSize = 10 * 1024 * 1024) {
  const originalSize = buffer.length;
  
  // If already under target size, no compression needed
  if (originalSize <= maxSize) {
    return { buffer, compressed: false, originalSize, finalSize: originalSize };
  }
  
  console.log(`🗜️ Compressing large image: ${(originalSize / 1024 / 1024).toFixed(1)}MB`);
  
  try {
    let sharpImage = sharp(buffer);
    const metadata = await sharpImage.metadata();
    
    // Detect if image might be a screenshot (high width/height ratio suggests text content)
    const isLikelyScreenshot = metadata.width > 1200 && metadata.height > 600;
    
    // Smart compression strategy based on image type and content
    if (mimeType === 'image/png') {
      if (isLikelyScreenshot) {
        // For screenshots: Use higher quality JPEG (90%) to preserve text
        console.log(`📸 Screenshot detected, using high-quality compression`);
        sharpImage = sharpImage.jpeg({ quality: 90, progressive: true });
      } else {
        // For graphics: Standard quality is fine
        sharpImage = sharpImage.jpeg({ quality: 85, progressive: true });
      }
    } else if (mimeType === 'image/jpeg') {
      // JPEG: reduce quality progressively but stop higher for screenshots
      const minQuality = isLikelyScreenshot ? 70 : 40; // Higher minimum for text
      let quality = 85; // Start higher for better text
      let compressed;
      
      do {
        compressed = await sharp(buffer).jpeg({ quality, progressive: true }).toBuffer();
        if (compressed.length <= maxSize || quality <= minQuality) break;
        quality -= 5; // Smaller steps for finer control
      } while (quality > minQuality);
      
      const finalSize = compressed.length;
      console.log(`✅ JPEG compressed: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(finalSize / 1024 / 1024).toFixed(1)}MB (${quality}% quality)`);
      return { buffer: compressed, compressed: true, originalSize, finalSize };
    }
    
    // Conservative resizing: Only if extremely large AND only modest reduction
    if (metadata.width > 2560) { // Only resize beyond 2.5K
      const scale = Math.max(0.75, Math.min(2560 / metadata.width, 1440 / metadata.height)); // Max 25% reduction
      if (scale < 1) {
        sharpImage = sharpImage.resize(
          Math.round(metadata.width * scale), 
          Math.round(metadata.height * scale),
          { 
            kernel: sharp.kernel.lanczos3, // Better quality for text
            withoutEnlargement: true 
          }
        );
        console.log(`📐 Conservative resize: ${metadata.width}x${metadata.height} → ${Math.round(metadata.width * scale)}x${Math.round(metadata.height * scale)} (${Math.round(scale * 100)}%)`);
      }
    }
    
    const compressed = await sharpImage.toBuffer();
    const finalSize = compressed.length;
    
    const compressionRatio = ((originalSize - finalSize) / originalSize * 100).toFixed(1);
    console.log(`✅ Image compressed: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(finalSize / 1024 / 1024).toFixed(1)}MB (${compressionRatio}% reduction)`);
    return { buffer: compressed, compressed: true, originalSize, finalSize };
    
  } catch (error) {
    console.error('❌ Compression failed, using original:', error.message);
    return { buffer, compressed: false, originalSize, finalSize: originalSize };
  }
}

/**
 * Validate image file format by checking magic bytes
 * @param {Buffer} buffer - Image buffer to validate
 * @param {string} mimeType - Expected MIME type
 * @returns {boolean} True if magic bytes match expected type
 */
export function validateImageMagicBytes(buffer, mimeType) {
  if (buffer.length < 12) return false;
  
  const header = buffer.subarray(0, 12);
  
  switch (mimeType) {
    case 'image/jpeg':
      return header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF;
    case 'image/png':
      return header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
    case 'image/gif':
      return header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46;
    case 'image/webp':
      return header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;
    default:
      return false;
  }
}

/**
 * Get memory usage statistics for monitoring
 * @returns {Object} Memory usage information
 */
export function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024), // MB
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
    external: Math.round(usage.external / 1024 / 1024), // MB
  };
}