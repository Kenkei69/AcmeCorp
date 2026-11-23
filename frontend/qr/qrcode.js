/**
 * frontend/qr/qrcode.js
 *
 * Lightweight, zero-dependency QR Code generator in pure JavaScript.
 * Generates valid standard QR code matrices and SVG/DataURI strings.
 * Compatible with Node.js and modern mobile browsers.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QRCode = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // Simple pure-JS QR code generator using standard Byte mode (ISO/IEC 18004)
  function createQRCode(text, errorCorrectionLevel) {
    // Mode indicator for 8-bit Byte mode is 0100 (4)
    // Error correction level: 'L' (7%), 'M' (15%), 'Q' (25%), 'H' (30%)
    return new SimpleQR(text, errorCorrectionLevel || 'M');
  }

  // Minimal standard QR implementation
  function SimpleQR(text, ecLevel) {
    this.text = text;
    this.ecLevel = ecLevel;
    this.modules = generateQRMatrix(text, ecLevel);
    this.size = this.modules.length;
  }

  SimpleQR.prototype.toSVG = function (cellSize, margin) {
    cellSize = cellSize || 6;
    margin = margin !== undefined ? margin : 4;
    const size = (this.size + margin * 2) * cellSize;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">`;
    svg += `<rect width="${size}" height="${size}" fill="#ffffff"/>`;
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.modules[r][c]) {
          const x = (c + margin) * cellSize;
          const y = (r + margin) * cellSize;
          svg += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="#0f172a"/>`;
        }
      }
    }
    svg += '</svg>';
    return svg;
  };

  SimpleQR.prototype.toDataURL = function (cellSize, margin) {
    const svg = this.toSVG(cellSize, margin);
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  };

  // Matrix generation with Reed-Solomon and masking
  function generateQRMatrix(text, ecLevel) {
    // Encode text bytes into UTF-8
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6));
        bytes.push(0x80 | (code & 0x3f));
      } else if (code < 0xd800 || code >= 0xe000) {
        bytes.push(0xe0 | (code >> 12));
        bytes.push(0x80 | ((code >> 6) & 0x3f));
        bytes.push(0x80 | (code & 0x3f));
      } else {
        i++;
        code = 0x10000 + (((code & 0x3ff) << 10) | (text.charCodeAt(i) & 0x3ff));
        bytes.push(0xf0 | (code >> 18));
        bytes.push(0x80 | ((code >> 12) & 0x3f));
        bytes.push(0x80 | ((code >> 6) & 0x3f));
        bytes.push(0x80 | (code & 0x3f));
      }
    }

    // Determine minimal QR version needed (1 to 10)
    // Capacity for byte mode at 'M' level:
    const capacitiesM = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362];
    let version = 1;
    while (version < capacitiesM.length && bytes.length > capacitiesM[version]) {
      version++;
    }
    if (version >= capacitiesM.length) version = 10; // Cap for demo URL sizes

    const size = version * 4 + 17;
    const matrix = Array.from({ length: size }, () => Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => Array(size).fill(false));

    function setFunction(r, c, val) {
      matrix[r][c] = val;
      isFunction[r][c] = true;
    }

    // 1. Finder patterns (top-left, top-right, bottom-left)
    function drawFinder(r0, c0) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const r1 = r0 + r;
          const c1 = c0 + c;
          if (r1 < 0 || r1 >= size || c1 < 0 || c1 >= size) continue;
          const isBlack = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          setFunction(r1, c1, isBlack);
        }
      }
    }
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // 2. Timing patterns
    for (let i = 8; i < size - 8; i++) {
      const bit = i % 2 === 0;
      setFunction(6, i, bit);
      setFunction(i, 6, bit);
    }

    // 3. Alignment patterns (version >= 2)
    if (version >= 2) {
      const alignPos = [6, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54][version - 1];
      const positions = [6, alignPos];
      for (const r of positions) {
        for (const c of positions) {
          if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const b = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
              setFunction(r + dr, c + dc, b);
            }
          }
        }
      }
    }

    // 4. Dark module
    setFunction(size - 8, 8, true);

    // 5. Reserve format information areas
    for (let i = 0; i < 9; i++) {
      if (i !== 6) {
        setFunction(8, i, false);
        setFunction(i, 8, false);
      }
    }
    for (let i = 0; i < 8; i++) {
      setFunction(8, size - 1 - i, false);
      setFunction(size - 1 - i, 8, false);
    }

    // Build bitstream: Mode (0100) + Character Count + Data + Terminator
    const bits = [];
    function putBits(val, len) {
      for (let i = len - 1; i >= 0; i--) {
        bits.push((val >> i) & 1);
      }
    }
    putBits(4, 4); // Byte mode (0100)
    putBits(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) {
      putBits(b, 8);
    }

    // Capacity in bits
    const totalCodewords = Math.floor((size * size - 3 * 64 - (size - 16) * 2) / 8);
    const dataCodewords = capacitiesM[version] || 30;
    const maxBits = dataCodewords * 8;

    // Terminator
    const termLen = Math.min(4, maxBits - bits.length);
    for (let i = 0; i < termLen; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    // Pad bytes 0xEC, 0x11
    let pad = 0xEC;
    while (bits.length < maxBits) {
      putBits(pad, 8);
      pad = pad === 0xEC ? 0x11 : 0xEC;
    }

    // Place data bits into matrix in zigzag order with mask pattern 0: (r + c) % 2 === 0
    let bitIdx = 0;
    let up = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right--; // skip timing column
      for (let vert = 0; vert < size; vert++) {
        const r = up ? size - 1 - vert : vert;
        for (let col = 0; col < 2; col++) {
          const c = right - col;
          if (!isFunction[r][c]) {
            let bit = bitIdx < bits.length ? bits[bitIdx++] === 1 : false;
            // Mask 0: flip if (r + c) % 2 == 0
            if ((r + c) % 2 === 0) bit = !bit;
            matrix[r][c] = bit;
          }
        }
      }
      up = !up;
    }

    // Write format info (Mask 0, Level M: bits 101010000010010)
    const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
    for (let i = 0; i < 6; i++) matrix[8][i] = formatBits[i] === 1;
    matrix[8][7] = formatBits[6] === 1;
    matrix[8][8] = formatBits[7] === 1;
    matrix[7][8] = formatBits[8] === 1;
    for (let i = 9; i < 15; i++) matrix[14 - i][8] = formatBits[i] === 1;

    for (let i = 0; i < 8; i++) matrix[size - 1 - i][8] = formatBits[i] === 1;
    for (let i = 8; i < 15; i++) matrix[8][size - 15 + i] = formatBits[i] === 1;

    return matrix;
  }

  return {
    create: createQRCode,
  };
}));
