#!/usr/bin/env node
const fs = require('fs');
const { minify } = require('terser');
const path = require('path');

async function build() {
  const distDir = path.join(__dirname, 'dist');
  
  // Создаём папку dist если не существует
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }
  
  // UTF-8 BOM для гарантированного распознавания кодировки
  const BOM = '\uFEFF';
  
  // ============================================
  // 1. IIFE версия: prefetch.js → dist/prefetch.min.js
  // ============================================
  const iifeCode = fs.readFileSync(path.join(__dirname, 'prefetch.js'), 'utf8');
  
  const iifeResult = await minify(iifeCode, {
    compress: true,
    mangle: true,
    format: {
      comments: /^!/ // Сохраняем только комментарии с ! (лицензионные)
    }
  });
  
  fs.writeFileSync(path.join(distDir, 'prefetch.min.js'), BOM + iifeResult.code, 'utf8');
  console.log('✓ Build complete: dist/prefetch.min.js');
  
  // ============================================
  // 2. ESM версия: prefetch.esm.js → dist/prefetch.esm.min.js
  // ============================================
  const esmPath = path.join(__dirname, 'prefetch.esm.js');
  
  if (fs.existsSync(esmPath)) {
    const esmCode = fs.readFileSync(esmPath, 'utf8');
    
    const esmResult = await minify(esmCode, {
      module: true, // Ключевое отличие для ESM
      compress: true,
      mangle: true,
      format: {
        comments: /^!/ // Сохраняем только комментарии с ! (лицензионные)
      }
    });
    
    fs.writeFileSync(path.join(distDir, 'prefetch.esm.min.js'), BOM + esmResult.code, 'utf8');
    console.log('✓ Build complete: dist/prefetch.esm.min.js');
  } else {
    console.log('ℹ️ prefetch.esm.js not found, skipping ESM build');
  }
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
