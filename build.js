#!/usr/bin/env node
const fs = require('fs');
const { minify } = require('terser');
const path = require('path');

async function build() {
  const inputFile = path.join(__dirname, 'prefetch.js');
  const outputFile = path.join(__dirname, 'dist', 'prefetch.min.js');
  
  // Читаем исходный файл в UTF-8
  const code = fs.readFileSync(inputFile, 'utf8');
  
  // Минифицируем
  const result = await minify(code, {
    compress: true,
    mangle: true,
    format: {
      comments: /^!/ // Сохраняем только комментарии с ! (лицензионные)
    }
  });
  
  // Записываем результат в UTF-8 с BOM для гарантированного распознавания кодировки
  const BOM = '\uFEFF';
  fs.writeFileSync(outputFile, BOM + result.code, 'utf8');
  
  console.log('✓ Build complete: dist/prefetch.min.js');
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
