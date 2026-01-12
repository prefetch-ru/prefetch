#!/usr/bin/env node
/**
 * Build script for prefetch.ru
 * 
 * Generates:
 * - prefetch.js (IIFE, unminified)
 * - prefetch.esm.js (ESM, unminified)
 * - dist/prefetch.min.js (IIFE, minified)
 * - dist/prefetch.esm.min.js (ESM, minified)
 */
const fs = require('fs')
const path = require('path')
const { rollup } = require('rollup')
const { minify } = require('terser')

const pkg = require('./package.json')
const VERSION = pkg.version

// Banner для файлов
const BANNER_IIFE = `/*!
 * prefetch.ru v${VERSION} - Мгновенная загрузка страниц
 * © 2026 Сергей Макаров | MIT License
 * https://prefetch.ru | https://github.com/prefetch-ru
 */`

const BANNER_ESM = `/*!
 * prefetch.ru v${VERSION} (ESM) - Мгновенная загрузка страниц
 * © 2026 Сергей Макаров | MIT License
 * https://prefetch.ru | https://github.com/prefetch-ru
 */`

// UTF-8 BOM для гарантированного распознавания кодировки
const BOM = '\uFEFF'

// Rollup plugin для замены __VERSION__
function replaceVersion() {
  return {
    name: 'replace-version',
    transform(code) {
      return {
        code: code.replace(/__VERSION__/g, VERSION),
        map: null
      }
    }
  }
}

async function build() {
  const distDir = path.join(__dirname, 'dist')
  
  // Создаём папку dist если не существует
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true })
  }

  console.log(`📦 Building prefetch.ru v${VERSION}...\n`)

  // ============================================
  // 1. IIFE версия: src/entry-iife.js → prefetch.js
  // ============================================
  console.log('🔨 Building IIFE version...')
  
  const iifeBundle = await rollup({
    input: path.join(__dirname, 'src/entry-iife.js'),
    plugins: [replaceVersion()]
  })

  const iifeOutput = await iifeBundle.generate({
    format: 'iife',  // Rollup добавит IIFE обёртку
    banner: BANNER_IIFE,
    compact: false
  })

  let iifeCode = iifeOutput.output[0].code

  fs.writeFileSync(path.join(__dirname, 'prefetch.js'), BOM + iifeCode, 'utf8')
  console.log('  ✓ prefetch.js')

  // Minified IIFE
  const iifeMinified = await minify(iifeCode, {
    compress: true,
    mangle: true,
    format: {
      comments: /^!/  // Сохраняем только комментарии с ! (лицензионные)
    }
  })
  
  fs.writeFileSync(path.join(distDir, 'prefetch.min.js'), BOM + iifeMinified.code, 'utf8')
  console.log('  ✓ dist/prefetch.min.js')

  await iifeBundle.close()

  // ============================================
  // 2. ESM версия: src/entry-esm.js → prefetch.esm.js
  // ============================================
  console.log('🔨 Building ESM version...')
  
  const esmBundle = await rollup({
    input: path.join(__dirname, 'src/entry-esm.js'),
    plugins: [replaceVersion()]
  })

  const esmOutput = await esmBundle.generate({
    format: 'es',
    banner: BANNER_ESM,
    compact: false
  })

  let esmCode = esmOutput.output[0].code

  fs.writeFileSync(path.join(__dirname, 'prefetch.esm.js'), BOM + esmCode, 'utf8')
  console.log('  ✓ prefetch.esm.js')

  // Minified ESM
  const esmMinified = await minify(esmCode, {
    module: true,
    compress: true,
    mangle: true,
    format: {
      comments: /^!/  // Сохраняем только комментарии с ! (лицензионные)
    }
  })
  
  fs.writeFileSync(path.join(distDir, 'prefetch.esm.min.js'), BOM + esmMinified.code, 'utf8')
  console.log('  ✓ dist/prefetch.esm.min.js')

  await esmBundle.close()

  // ============================================
  // Summary
  // ============================================
  console.log('\n✅ Build complete!\n')
  
  const files = [
    'prefetch.js',
    'prefetch.esm.js',
    'dist/prefetch.min.js',
    'dist/prefetch.esm.min.js'
  ]
  
  console.log('📄 Generated files:')
  for (const file of files) {
    const filePath = path.join(__dirname, file)
    const size = fs.statSync(filePath).size
    const sizeKb = (size / 1024).toFixed(2)
    console.log(`   ${file}: ${sizeKb} KB`)
  }
}

build().catch(err => {
  console.error('❌ Build failed:', err)
  process.exit(1)
})
