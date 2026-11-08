var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod2) => function __require() {
  return mod2 || (0, cb[__getOwnPropNames(cb)[0]])((mod2 = { exports: {} }).exports, mod2), mod2.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod2, isNodeMode, target) => (target = mod2 != null ? __create(__getProtoOf(mod2)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod2 || !mod2.__esModule ? __defProp(target, "default", { value: mod2, enumerable: true }) : target,
  mod2
));

// node_modules/qrcode-generator/qrcode.js
var require_qrcode = __commonJS({
  "node_modules/qrcode-generator/qrcode.js"(exports, module) {
    var qrcode = function() {
      var qrcode2 = function(typeNumber, errorCorrectionLevel) {
        var PAD0 = 236;
        var PAD1 = 17;
        var _typeNumber = typeNumber;
        var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
        var _modules = null;
        var _moduleCount = 0;
        var _dataCache = null;
        var _dataList = [];
        var _this = {};
        var makeImpl = function(test, maskPattern) {
          _moduleCount = _typeNumber * 4 + 17;
          _modules = function(moduleCount) {
            var modules = new Array(moduleCount);
            for (var row = 0; row < moduleCount; row += 1) {
              modules[row] = new Array(moduleCount);
              for (var col = 0; col < moduleCount; col += 1) {
                modules[row][col] = null;
              }
            }
            return modules;
          }(_moduleCount);
          setupPositionProbePattern(0, 0);
          setupPositionProbePattern(_moduleCount - 7, 0);
          setupPositionProbePattern(0, _moduleCount - 7);
          setupPositionAdjustPattern();
          setupTimingPattern();
          setupTypeInfo(test, maskPattern);
          if (_typeNumber >= 7) {
            setupTypeNumber(test);
          }
          if (_dataCache == null) {
            _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
          }
          mapData(_dataCache, maskPattern);
        };
        var setupPositionProbePattern = function(row, col) {
          for (var r = -1; r <= 7; r += 1) {
            if (row + r <= -1 || _moduleCount <= row + r) continue;
            for (var c = -1; c <= 7; c += 1) {
              if (col + c <= -1 || _moduleCount <= col + c) continue;
              if (0 <= r && r <= 6 && (c == 0 || c == 6) || 0 <= c && c <= 6 && (r == 0 || r == 6) || 2 <= r && r <= 4 && 2 <= c && c <= 4) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        };
        var getBestMaskPattern = function() {
          var minLostPoint = 0;
          var pattern = 0;
          for (var i = 0; i < 8; i += 1) {
            makeImpl(true, i);
            var lostPoint = QRUtil.getLostPoint(_this);
            if (i == 0 || minLostPoint > lostPoint) {
              minLostPoint = lostPoint;
              pattern = i;
            }
          }
          return pattern;
        };
        var setupTimingPattern = function() {
          for (var r = 8; r < _moduleCount - 8; r += 1) {
            if (_modules[r][6] != null) {
              continue;
            }
            _modules[r][6] = r % 2 == 0;
          }
          for (var c = 8; c < _moduleCount - 8; c += 1) {
            if (_modules[6][c] != null) {
              continue;
            }
            _modules[6][c] = c % 2 == 0;
          }
        };
        var setupPositionAdjustPattern = function() {
          var pos = QRUtil.getPatternPosition(_typeNumber);
          for (var i = 0; i < pos.length; i += 1) {
            for (var j = 0; j < pos.length; j += 1) {
              var row = pos[i];
              var col = pos[j];
              if (_modules[row][col] != null) {
                continue;
              }
              for (var r = -2; r <= 2; r += 1) {
                for (var c = -2; c <= 2; c += 1) {
                  if (r == -2 || r == 2 || c == -2 || c == 2 || r == 0 && c == 0) {
                    _modules[row + r][col + c] = true;
                  } else {
                    _modules[row + r][col + c] = false;
                  }
                }
              }
            }
          }
        };
        var setupTypeNumber = function(test) {
          var bits = QRUtil.getBCHTypeNumber(_typeNumber);
          for (var i = 0; i < 18; i += 1) {
            var mod2 = !test && (bits >> i & 1) == 1;
            _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod2;
          }
          for (var i = 0; i < 18; i += 1) {
            var mod2 = !test && (bits >> i & 1) == 1;
            _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod2;
          }
        };
        var setupTypeInfo = function(test, maskPattern) {
          var data = _errorCorrectionLevel << 3 | maskPattern;
          var bits = QRUtil.getBCHTypeInfo(data);
          for (var i = 0; i < 15; i += 1) {
            var mod2 = !test && (bits >> i & 1) == 1;
            if (i < 6) {
              _modules[i][8] = mod2;
            } else if (i < 8) {
              _modules[i + 1][8] = mod2;
            } else {
              _modules[_moduleCount - 15 + i][8] = mod2;
            }
          }
          for (var i = 0; i < 15; i += 1) {
            var mod2 = !test && (bits >> i & 1) == 1;
            if (i < 8) {
              _modules[8][_moduleCount - i - 1] = mod2;
            } else if (i < 9) {
              _modules[8][15 - i - 1 + 1] = mod2;
            } else {
              _modules[8][15 - i - 1] = mod2;
            }
          }
          _modules[_moduleCount - 8][8] = !test;
        };
        var mapData = function(data, maskPattern) {
          var inc = -1;
          var row = _moduleCount - 1;
          var bitIndex = 7;
          var byteIndex = 0;
          var maskFunc = QRUtil.getMaskFunction(maskPattern);
          for (var col = _moduleCount - 1; col > 0; col -= 2) {
            if (col == 6) col -= 1;
            while (true) {
              for (var c = 0; c < 2; c += 1) {
                if (_modules[row][col - c] == null) {
                  var dark = false;
                  if (byteIndex < data.length) {
                    dark = (data[byteIndex] >>> bitIndex & 1) == 1;
                  }
                  var mask = maskFunc(row, col - c);
                  if (mask) {
                    dark = !dark;
                  }
                  _modules[row][col - c] = dark;
                  bitIndex -= 1;
                  if (bitIndex == -1) {
                    byteIndex += 1;
                    bitIndex = 7;
                  }
                }
              }
              row += inc;
              if (row < 0 || _moduleCount <= row) {
                row -= inc;
                inc = -inc;
                break;
              }
            }
          }
        };
        var createBytes2 = function(buffer, rsBlocks) {
          var offset = 0;
          var maxDcCount = 0;
          var maxEcCount = 0;
          var dcdata = new Array(rsBlocks.length);
          var ecdata = new Array(rsBlocks.length);
          for (var r = 0; r < rsBlocks.length; r += 1) {
            var dcCount = rsBlocks[r].dataCount;
            var ecCount = rsBlocks[r].totalCount - dcCount;
            maxDcCount = Math.max(maxDcCount, dcCount);
            maxEcCount = Math.max(maxEcCount, ecCount);
            dcdata[r] = new Array(dcCount);
            for (var i = 0; i < dcdata[r].length; i += 1) {
              dcdata[r][i] = 255 & buffer.getBuffer()[i + offset];
            }
            offset += dcCount;
            var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
            var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);
            var modPoly = rawPoly.mod(rsPoly);
            ecdata[r] = new Array(rsPoly.getLength() - 1);
            for (var i = 0; i < ecdata[r].length; i += 1) {
              var modIndex = i + modPoly.getLength() - ecdata[r].length;
              ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
            }
          }
          var totalCodeCount = 0;
          for (var i = 0; i < rsBlocks.length; i += 1) {
            totalCodeCount += rsBlocks[i].totalCount;
          }
          var data = new Array(totalCodeCount);
          var index = 0;
          for (var i = 0; i < maxDcCount; i += 1) {
            for (var r = 0; r < rsBlocks.length; r += 1) {
              if (i < dcdata[r].length) {
                data[index] = dcdata[r][i];
                index += 1;
              }
            }
          }
          for (var i = 0; i < maxEcCount; i += 1) {
            for (var r = 0; r < rsBlocks.length; r += 1) {
              if (i < ecdata[r].length) {
                data[index] = ecdata[r][i];
                index += 1;
              }
            }
          }
          return data;
        };
        var createData = function(typeNumber2, errorCorrectionLevel2, dataList) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, errorCorrectionLevel2);
          var buffer = qrBitBuffer();
          for (var i = 0; i < dataList.length; i += 1) {
            var data = dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
            data.write(buffer);
          }
          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i += 1) {
            totalDataCount += rsBlocks[i].dataCount;
          }
          if (buffer.getLengthInBits() > totalDataCount * 8) {
            throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
          }
          if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
            buffer.put(0, 4);
          }
          while (buffer.getLengthInBits() % 8 != 0) {
            buffer.putBit(false);
          }
          while (true) {
            if (buffer.getLengthInBits() >= totalDataCount * 8) {
              break;
            }
            buffer.put(PAD0, 8);
            if (buffer.getLengthInBits() >= totalDataCount * 8) {
              break;
            }
            buffer.put(PAD1, 8);
          }
          return createBytes2(buffer, rsBlocks);
        };
        _this.addData = function(data, mode) {
          mode = mode || "Byte";
          var newData = null;
          switch (mode) {
            case "Numeric":
              newData = qrNumber(data);
              break;
            case "Alphanumeric":
              newData = qrAlphaNum(data);
              break;
            case "Byte":
              newData = qr8BitByte(data);
              break;
            case "Kanji":
              newData = qrKanji(data);
              break;
            default:
              throw "mode:" + mode;
          }
          _dataList.push(newData);
          _dataCache = null;
        };
        _this.isDark = function(row, col) {
          if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
            throw row + "," + col;
          }
          return _modules[row][col];
        };
        _this.getModuleCount = function() {
          return _moduleCount;
        };
        _this.make = function() {
          if (_typeNumber < 1) {
            var typeNumber2 = 1;
            for (; typeNumber2 < 40; typeNumber2++) {
              var rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, _errorCorrectionLevel);
              var buffer = qrBitBuffer();
              for (var i = 0; i < _dataList.length; i++) {
                var data = _dataList[i];
                buffer.put(data.getMode(), 4);
                buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
                data.write(buffer);
              }
              var totalDataCount = 0;
              for (var i = 0; i < rsBlocks.length; i++) {
                totalDataCount += rsBlocks[i].dataCount;
              }
              if (buffer.getLengthInBits() <= totalDataCount * 8) {
                break;
              }
            }
            _typeNumber = typeNumber2;
          }
          makeImpl(false, getBestMaskPattern());
        };
        _this.createTableTag = function(cellSize, margin) {
          cellSize = cellSize || 2;
          margin = typeof margin == "undefined" ? cellSize * 4 : margin;
          var qrHtml = "";
          qrHtml += '<table style="';
          qrHtml += " border-width: 0px; border-style: none;";
          qrHtml += " border-collapse: collapse;";
          qrHtml += " padding: 0px; margin: " + margin + "px;";
          qrHtml += '">';
          qrHtml += "<tbody>";
          for (var r = 0; r < _this.getModuleCount(); r += 1) {
            qrHtml += "<tr>";
            for (var c = 0; c < _this.getModuleCount(); c += 1) {
              qrHtml += '<td style="';
              qrHtml += " border-width: 0px; border-style: none;";
              qrHtml += " border-collapse: collapse;";
              qrHtml += " padding: 0px; margin: 0px;";
              qrHtml += " width: " + cellSize + "px;";
              qrHtml += " height: " + cellSize + "px;";
              qrHtml += " background-color: ";
              qrHtml += _this.isDark(r, c) ? "#000000" : "#ffffff";
              qrHtml += ";";
              qrHtml += '"/>';
            }
            qrHtml += "</tr>";
          }
          qrHtml += "</tbody>";
          qrHtml += "</table>";
          return qrHtml;
        };
        _this.createSvgTag = function(cellSize, margin, alt, title) {
          var opts = {};
          if (typeof arguments[0] == "object") {
            opts = arguments[0];
            cellSize = opts.cellSize;
            margin = opts.margin;
            alt = opts.alt;
            title = opts.title;
          }
          cellSize = cellSize || 2;
          margin = typeof margin == "undefined" ? cellSize * 4 : margin;
          alt = typeof alt === "string" ? { text: alt } : alt || {};
          alt.text = alt.text || null;
          alt.id = alt.text ? alt.id || "qrcode-description" : null;
          title = typeof title === "string" ? { text: title } : title || {};
          title.text = title.text || null;
          title.id = title.text ? title.id || "qrcode-title" : null;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var c, mc, r, mr, qrSvg = "", rect;
          rect = "l" + cellSize + ",0 0," + cellSize + " -" + cellSize + ",0 0,-" + cellSize + "z ";
          qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
          qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : "";
          qrSvg += ' viewBox="0 0 ' + size + " " + size + '" ';
          qrSvg += ' preserveAspectRatio="xMinYMin meet"';
          qrSvg += title.text || alt.text ? ' role="img" aria-labelledby="' + escapeXml([title.id, alt.id].join(" ").trim()) + '"' : "";
          qrSvg += ">";
          qrSvg += title.text ? '<title id="' + escapeXml(title.id) + '">' + escapeXml(title.text) + "</title>" : "";
          qrSvg += alt.text ? '<description id="' + escapeXml(alt.id) + '">' + escapeXml(alt.text) + "</description>" : "";
          qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
          qrSvg += '<path d="';
          for (r = 0; r < _this.getModuleCount(); r += 1) {
            mr = r * cellSize + margin;
            for (c = 0; c < _this.getModuleCount(); c += 1) {
              if (_this.isDark(r, c)) {
                mc = c * cellSize + margin;
                qrSvg += "M" + mc + "," + mr + rect;
              }
            }
          }
          qrSvg += '" stroke="transparent" fill="black"/>';
          qrSvg += "</svg>";
          return qrSvg;
        };
        _this.createDataURL = function(cellSize, margin) {
          cellSize = cellSize || 2;
          margin = typeof margin == "undefined" ? cellSize * 4 : margin;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;
          return createDataURL(size, size, function(x, y) {
            if (min <= x && x < max && min <= y && y < max) {
              var c = Math.floor((x - min) / cellSize);
              var r = Math.floor((y - min) / cellSize);
              return _this.isDark(r, c) ? 0 : 1;
            } else {
              return 1;
            }
          });
        };
        _this.createImgTag = function(cellSize, margin, alt) {
          cellSize = cellSize || 2;
          margin = typeof margin == "undefined" ? cellSize * 4 : margin;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var img = "";
          img += "<img";
          img += ' src="';
          img += _this.createDataURL(cellSize, margin);
          img += '"';
          img += ' width="';
          img += size;
          img += '"';
          img += ' height="';
          img += size;
          img += '"';
          if (alt) {
            img += ' alt="';
            img += escapeXml(alt);
            img += '"';
          }
          img += "/>";
          return img;
        };
        var escapeXml = function(s) {
          var escaped = "";
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charAt(i);
            switch (c) {
              case "<":
                escaped += "&lt;";
                break;
              case ">":
                escaped += "&gt;";
                break;
              case "&":
                escaped += "&amp;";
                break;
              case '"':
                escaped += "&quot;";
                break;
              default:
                escaped += c;
                break;
            }
          }
          return escaped;
        };
        var _createHalfASCII = function(margin) {
          var cellSize = 1;
          margin = typeof margin == "undefined" ? cellSize * 2 : margin;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;
          var y, x, r1, r2, p;
          var blocks = {
            "\u2588\u2588": "\u2588",
            "\u2588 ": "\u2580",
            " \u2588": "\u2584",
            "  ": " "
          };
          var blocksLastLineNoMargin = {
            "\u2588\u2588": "\u2580",
            "\u2588 ": "\u2580",
            " \u2588": " ",
            "  ": " "
          };
          var ascii = "";
          for (y = 0; y < size; y += 2) {
            r1 = Math.floor((y - min) / cellSize);
            r2 = Math.floor((y + 1 - min) / cellSize);
            for (x = 0; x < size; x += 1) {
              p = "\u2588";
              if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
                p = " ";
              }
              if (min <= x && x < max && min <= y + 1 && y + 1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
                p += " ";
              } else {
                p += "\u2588";
              }
              ascii += margin < 1 && y + 1 >= max ? blocksLastLineNoMargin[p] : blocks[p];
            }
            ascii += "\n";
          }
          if (size % 2 && margin > 0) {
            return ascii.substring(0, ascii.length - size - 1) + Array(size + 1).join("\u2580");
          }
          return ascii.substring(0, ascii.length - 1);
        };
        _this.createASCII = function(cellSize, margin) {
          cellSize = cellSize || 1;
          if (cellSize < 2) {
            return _createHalfASCII(margin);
          }
          cellSize -= 1;
          margin = typeof margin == "undefined" ? cellSize * 2 : margin;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;
          var y, x, r, p;
          var white = Array(cellSize + 1).join("\u2588\u2588");
          var black = Array(cellSize + 1).join("  ");
          var ascii = "";
          var line = "";
          for (y = 0; y < size; y += 1) {
            r = Math.floor((y - min) / cellSize);
            line = "";
            for (x = 0; x < size; x += 1) {
              p = 1;
              if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
                p = 0;
              }
              line += p ? white : black;
            }
            for (r = 0; r < cellSize; r += 1) {
              ascii += line + "\n";
            }
          }
          return ascii.substring(0, ascii.length - 1);
        };
        _this.renderTo2dContext = function(context, cellSize) {
          cellSize = cellSize || 2;
          var length = _this.getModuleCount();
          for (var row = 0; row < length; row++) {
            for (var col = 0; col < length; col++) {
              context.fillStyle = _this.isDark(row, col) ? "black" : "white";
              context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
            }
          }
        };
        return _this;
      };
      qrcode2.stringToBytesFuncs = {
        "default": function(s) {
          var bytes = [];
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            bytes.push(c & 255);
          }
          return bytes;
        }
      };
      qrcode2.stringToBytes = qrcode2.stringToBytesFuncs["default"];
      qrcode2.createStringToBytes = function(unicodeData, numChars) {
        var unicodeMap = function() {
          var bin = base64DecodeInputStream(unicodeData);
          var read = function() {
            var b = bin.read();
            if (b == -1) throw "eof";
            return b;
          };
          var count = 0;
          var unicodeMap2 = {};
          while (true) {
            var b0 = bin.read();
            if (b0 == -1) break;
            var b1 = read();
            var b2 = read();
            var b3 = read();
            var k = String.fromCharCode(b0 << 8 | b1);
            var v = b2 << 8 | b3;
            unicodeMap2[k] = v;
            count += 1;
          }
          if (count != numChars) {
            throw count + " != " + numChars;
          }
          return unicodeMap2;
        }();
        var unknownChar = "?".charCodeAt(0);
        return function(s) {
          var bytes = [];
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            if (c < 128) {
              bytes.push(c);
            } else {
              var b = unicodeMap[s.charAt(i)];
              if (typeof b == "number") {
                if ((b & 255) == b) {
                  bytes.push(b);
                } else {
                  bytes.push(b >>> 8);
                  bytes.push(b & 255);
                }
              } else {
                bytes.push(unknownChar);
              }
            }
          }
          return bytes;
        };
      };
      var QRMode = {
        MODE_NUMBER: 1 << 0,
        MODE_ALPHA_NUM: 1 << 1,
        MODE_8BIT_BYTE: 1 << 2,
        MODE_KANJI: 1 << 3
      };
      var QRErrorCorrectionLevel = {
        L: 1,
        M: 0,
        Q: 3,
        H: 2
      };
      var QRMaskPattern = {
        PATTERN000: 0,
        PATTERN001: 1,
        PATTERN010: 2,
        PATTERN011: 3,
        PATTERN100: 4,
        PATTERN101: 5,
        PATTERN110: 6,
        PATTERN111: 7
      };
      var QRUtil = function() {
        var PATTERN_POSITION_TABLE = [
          [],
          [6, 18],
          [6, 22],
          [6, 26],
          [6, 30],
          [6, 34],
          [6, 22, 38],
          [6, 24, 42],
          [6, 26, 46],
          [6, 28, 50],
          [6, 30, 54],
          [6, 32, 58],
          [6, 34, 62],
          [6, 26, 46, 66],
          [6, 26, 48, 70],
          [6, 26, 50, 74],
          [6, 30, 54, 78],
          [6, 30, 56, 82],
          [6, 30, 58, 86],
          [6, 34, 62, 90],
          [6, 28, 50, 72, 94],
          [6, 26, 50, 74, 98],
          [6, 30, 54, 78, 102],
          [6, 28, 54, 80, 106],
          [6, 32, 58, 84, 110],
          [6, 30, 58, 86, 114],
          [6, 34, 62, 90, 118],
          [6, 26, 50, 74, 98, 122],
          [6, 30, 54, 78, 102, 126],
          [6, 26, 52, 78, 104, 130],
          [6, 30, 56, 82, 108, 134],
          [6, 34, 60, 86, 112, 138],
          [6, 30, 58, 86, 114, 142],
          [6, 34, 62, 90, 118, 146],
          [6, 30, 54, 78, 102, 126, 150],
          [6, 24, 50, 76, 102, 128, 154],
          [6, 28, 54, 80, 106, 132, 158],
          [6, 32, 58, 84, 110, 136, 162],
          [6, 26, 54, 82, 110, 138, 166],
          [6, 30, 58, 86, 114, 142, 170]
        ];
        var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
        var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
        var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
        var _this = {};
        var getBCHDigit = function(data) {
          var digit = 0;
          while (data != 0) {
            digit += 1;
            data >>>= 1;
          }
          return digit;
        };
        _this.getBCHTypeInfo = function(data) {
          var d = data << 10;
          while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
            d ^= G15 << getBCHDigit(d) - getBCHDigit(G15);
          }
          return (data << 10 | d) ^ G15_MASK;
        };
        _this.getBCHTypeNumber = function(data) {
          var d = data << 12;
          while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
            d ^= G18 << getBCHDigit(d) - getBCHDigit(G18);
          }
          return data << 12 | d;
        };
        _this.getPatternPosition = function(typeNumber) {
          return PATTERN_POSITION_TABLE[typeNumber - 1];
        };
        _this.getMaskFunction = function(maskPattern) {
          switch (maskPattern) {
            case QRMaskPattern.PATTERN000:
              return function(i, j) {
                return (i + j) % 2 == 0;
              };
            case QRMaskPattern.PATTERN001:
              return function(i, j) {
                return i % 2 == 0;
              };
            case QRMaskPattern.PATTERN010:
              return function(i, j) {
                return j % 3 == 0;
              };
            case QRMaskPattern.PATTERN011:
              return function(i, j) {
                return (i + j) % 3 == 0;
              };
            case QRMaskPattern.PATTERN100:
              return function(i, j) {
                return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
              };
            case QRMaskPattern.PATTERN101:
              return function(i, j) {
                return i * j % 2 + i * j % 3 == 0;
              };
            case QRMaskPattern.PATTERN110:
              return function(i, j) {
                return (i * j % 2 + i * j % 3) % 2 == 0;
              };
            case QRMaskPattern.PATTERN111:
              return function(i, j) {
                return (i * j % 3 + (i + j) % 2) % 2 == 0;
              };
            default:
              throw "bad maskPattern:" + maskPattern;
          }
        };
        _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
          var a = qrPolynomial([1], 0);
          for (var i = 0; i < errorCorrectLength; i += 1) {
            a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0));
          }
          return a;
        };
        _this.getLengthInBits = function(mode, type) {
          if (1 <= type && type < 10) {
            switch (mode) {
              case QRMode.MODE_NUMBER:
                return 10;
              case QRMode.MODE_ALPHA_NUM:
                return 9;
              case QRMode.MODE_8BIT_BYTE:
                return 8;
              case QRMode.MODE_KANJI:
                return 8;
              default:
                throw "mode:" + mode;
            }
          } else if (type < 27) {
            switch (mode) {
              case QRMode.MODE_NUMBER:
                return 12;
              case QRMode.MODE_ALPHA_NUM:
                return 11;
              case QRMode.MODE_8BIT_BYTE:
                return 16;
              case QRMode.MODE_KANJI:
                return 10;
              default:
                throw "mode:" + mode;
            }
          } else if (type < 41) {
            switch (mode) {
              case QRMode.MODE_NUMBER:
                return 14;
              case QRMode.MODE_ALPHA_NUM:
                return 13;
              case QRMode.MODE_8BIT_BYTE:
                return 16;
              case QRMode.MODE_KANJI:
                return 12;
              default:
                throw "mode:" + mode;
            }
          } else {
            throw "type:" + type;
          }
        };
        _this.getLostPoint = function(qrcode3) {
          var moduleCount = qrcode3.getModuleCount();
          var lostPoint = 0;
          for (var row = 0; row < moduleCount; row += 1) {
            for (var col = 0; col < moduleCount; col += 1) {
              var sameCount = 0;
              var dark = qrcode3.isDark(row, col);
              for (var r = -1; r <= 1; r += 1) {
                if (row + r < 0 || moduleCount <= row + r) {
                  continue;
                }
                for (var c = -1; c <= 1; c += 1) {
                  if (col + c < 0 || moduleCount <= col + c) {
                    continue;
                  }
                  if (r == 0 && c == 0) {
                    continue;
                  }
                  if (dark == qrcode3.isDark(row + r, col + c)) {
                    sameCount += 1;
                  }
                }
              }
              if (sameCount > 5) {
                lostPoint += 3 + sameCount - 5;
              }
            }
          }
          ;
          for (var row = 0; row < moduleCount - 1; row += 1) {
            for (var col = 0; col < moduleCount - 1; col += 1) {
              var count = 0;
              if (qrcode3.isDark(row, col)) count += 1;
              if (qrcode3.isDark(row + 1, col)) count += 1;
              if (qrcode3.isDark(row, col + 1)) count += 1;
              if (qrcode3.isDark(row + 1, col + 1)) count += 1;
              if (count == 0 || count == 4) {
                lostPoint += 3;
              }
            }
          }
          for (var row = 0; row < moduleCount; row += 1) {
            for (var col = 0; col < moduleCount - 6; col += 1) {
              if (qrcode3.isDark(row, col) && !qrcode3.isDark(row, col + 1) && qrcode3.isDark(row, col + 2) && qrcode3.isDark(row, col + 3) && qrcode3.isDark(row, col + 4) && !qrcode3.isDark(row, col + 5) && qrcode3.isDark(row, col + 6)) {
                lostPoint += 40;
              }
            }
          }
          for (var col = 0; col < moduleCount; col += 1) {
            for (var row = 0; row < moduleCount - 6; row += 1) {
              if (qrcode3.isDark(row, col) && !qrcode3.isDark(row + 1, col) && qrcode3.isDark(row + 2, col) && qrcode3.isDark(row + 3, col) && qrcode3.isDark(row + 4, col) && !qrcode3.isDark(row + 5, col) && qrcode3.isDark(row + 6, col)) {
                lostPoint += 40;
              }
            }
          }
          var darkCount = 0;
          for (var col = 0; col < moduleCount; col += 1) {
            for (var row = 0; row < moduleCount; row += 1) {
              if (qrcode3.isDark(row, col)) {
                darkCount += 1;
              }
            }
          }
          var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
          lostPoint += ratio * 10;
          return lostPoint;
        };
        return _this;
      }();
      var QRMath = function() {
        var EXP_TABLE = new Array(256);
        var LOG_TABLE = new Array(256);
        for (var i = 0; i < 8; i += 1) {
          EXP_TABLE[i] = 1 << i;
        }
        for (var i = 8; i < 256; i += 1) {
          EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
        }
        for (var i = 0; i < 255; i += 1) {
          LOG_TABLE[EXP_TABLE[i]] = i;
        }
        var _this = {};
        _this.glog = function(n) {
          if (n < 1) {
            throw "glog(" + n + ")";
          }
          return LOG_TABLE[n];
        };
        _this.gexp = function(n) {
          while (n < 0) {
            n += 255;
          }
          while (n >= 256) {
            n -= 255;
          }
          return EXP_TABLE[n];
        };
        return _this;
      }();
      function qrPolynomial(num2, shift) {
        if (typeof num2.length == "undefined") {
          throw num2.length + "/" + shift;
        }
        var _num = function() {
          var offset = 0;
          while (offset < num2.length && num2[offset] == 0) {
            offset += 1;
          }
          var _num2 = new Array(num2.length - offset + shift);
          for (var i = 0; i < num2.length - offset; i += 1) {
            _num2[i] = num2[i + offset];
          }
          return _num2;
        }();
        var _this = {};
        _this.getAt = function(index) {
          return _num[index];
        };
        _this.getLength = function() {
          return _num.length;
        };
        _this.multiply = function(e) {
          var num3 = new Array(_this.getLength() + e.getLength() - 1);
          for (var i = 0; i < _this.getLength(); i += 1) {
            for (var j = 0; j < e.getLength(); j += 1) {
              num3[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i)) + QRMath.glog(e.getAt(j)));
            }
          }
          return qrPolynomial(num3, 0);
        };
        _this.mod = function(e) {
          if (_this.getLength() - e.getLength() < 0) {
            return _this;
          }
          var ratio = QRMath.glog(_this.getAt(0)) - QRMath.glog(e.getAt(0));
          var num3 = new Array(_this.getLength());
          for (var i = 0; i < _this.getLength(); i += 1) {
            num3[i] = _this.getAt(i);
          }
          for (var i = 0; i < e.getLength(); i += 1) {
            num3[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
          }
          return qrPolynomial(num3, 0).mod(e);
        };
        return _this;
      }
      ;
      var QRRSBlock = function() {
        var RS_BLOCK_TABLE = [
          // L
          // M
          // Q
          // H
          // 1
          [1, 26, 19],
          [1, 26, 16],
          [1, 26, 13],
          [1, 26, 9],
          // 2
          [1, 44, 34],
          [1, 44, 28],
          [1, 44, 22],
          [1, 44, 16],
          // 3
          [1, 70, 55],
          [1, 70, 44],
          [2, 35, 17],
          [2, 35, 13],
          // 4
          [1, 100, 80],
          [2, 50, 32],
          [2, 50, 24],
          [4, 25, 9],
          // 5
          [1, 134, 108],
          [2, 67, 43],
          [2, 33, 15, 2, 34, 16],
          [2, 33, 11, 2, 34, 12],
          // 6
          [2, 86, 68],
          [4, 43, 27],
          [4, 43, 19],
          [4, 43, 15],
          // 7
          [2, 98, 78],
          [4, 49, 31],
          [2, 32, 14, 4, 33, 15],
          [4, 39, 13, 1, 40, 14],
          // 8
          [2, 121, 97],
          [2, 60, 38, 2, 61, 39],
          [4, 40, 18, 2, 41, 19],
          [4, 40, 14, 2, 41, 15],
          // 9
          [2, 146, 116],
          [3, 58, 36, 2, 59, 37],
          [4, 36, 16, 4, 37, 17],
          [4, 36, 12, 4, 37, 13],
          // 10
          [2, 86, 68, 2, 87, 69],
          [4, 69, 43, 1, 70, 44],
          [6, 43, 19, 2, 44, 20],
          [6, 43, 15, 2, 44, 16],
          // 11
          [4, 101, 81],
          [1, 80, 50, 4, 81, 51],
          [4, 50, 22, 4, 51, 23],
          [3, 36, 12, 8, 37, 13],
          // 12
          [2, 116, 92, 2, 117, 93],
          [6, 58, 36, 2, 59, 37],
          [4, 46, 20, 6, 47, 21],
          [7, 42, 14, 4, 43, 15],
          // 13
          [4, 133, 107],
          [8, 59, 37, 1, 60, 38],
          [8, 44, 20, 4, 45, 21],
          [12, 33, 11, 4, 34, 12],
          // 14
          [3, 145, 115, 1, 146, 116],
          [4, 64, 40, 5, 65, 41],
          [11, 36, 16, 5, 37, 17],
          [11, 36, 12, 5, 37, 13],
          // 15
          [5, 109, 87, 1, 110, 88],
          [5, 65, 41, 5, 66, 42],
          [5, 54, 24, 7, 55, 25],
          [11, 36, 12, 7, 37, 13],
          // 16
          [5, 122, 98, 1, 123, 99],
          [7, 73, 45, 3, 74, 46],
          [15, 43, 19, 2, 44, 20],
          [3, 45, 15, 13, 46, 16],
          // 17
          [1, 135, 107, 5, 136, 108],
          [10, 74, 46, 1, 75, 47],
          [1, 50, 22, 15, 51, 23],
          [2, 42, 14, 17, 43, 15],
          // 18
          [5, 150, 120, 1, 151, 121],
          [9, 69, 43, 4, 70, 44],
          [17, 50, 22, 1, 51, 23],
          [2, 42, 14, 19, 43, 15],
          // 19
          [3, 141, 113, 4, 142, 114],
          [3, 70, 44, 11, 71, 45],
          [17, 47, 21, 4, 48, 22],
          [9, 39, 13, 16, 40, 14],
          // 20
          [3, 135, 107, 5, 136, 108],
          [3, 67, 41, 13, 68, 42],
          [15, 54, 24, 5, 55, 25],
          [15, 43, 15, 10, 44, 16],
          // 21
          [4, 144, 116, 4, 145, 117],
          [17, 68, 42],
          [17, 50, 22, 6, 51, 23],
          [19, 46, 16, 6, 47, 17],
          // 22
          [2, 139, 111, 7, 140, 112],
          [17, 74, 46],
          [7, 54, 24, 16, 55, 25],
          [34, 37, 13],
          // 23
          [4, 151, 121, 5, 152, 122],
          [4, 75, 47, 14, 76, 48],
          [11, 54, 24, 14, 55, 25],
          [16, 45, 15, 14, 46, 16],
          // 24
          [6, 147, 117, 4, 148, 118],
          [6, 73, 45, 14, 74, 46],
          [11, 54, 24, 16, 55, 25],
          [30, 46, 16, 2, 47, 17],
          // 25
          [8, 132, 106, 4, 133, 107],
          [8, 75, 47, 13, 76, 48],
          [7, 54, 24, 22, 55, 25],
          [22, 45, 15, 13, 46, 16],
          // 26
          [10, 142, 114, 2, 143, 115],
          [19, 74, 46, 4, 75, 47],
          [28, 50, 22, 6, 51, 23],
          [33, 46, 16, 4, 47, 17],
          // 27
          [8, 152, 122, 4, 153, 123],
          [22, 73, 45, 3, 74, 46],
          [8, 53, 23, 26, 54, 24],
          [12, 45, 15, 28, 46, 16],
          // 28
          [3, 147, 117, 10, 148, 118],
          [3, 73, 45, 23, 74, 46],
          [4, 54, 24, 31, 55, 25],
          [11, 45, 15, 31, 46, 16],
          // 29
          [7, 146, 116, 7, 147, 117],
          [21, 73, 45, 7, 74, 46],
          [1, 53, 23, 37, 54, 24],
          [19, 45, 15, 26, 46, 16],
          // 30
          [5, 145, 115, 10, 146, 116],
          [19, 75, 47, 10, 76, 48],
          [15, 54, 24, 25, 55, 25],
          [23, 45, 15, 25, 46, 16],
          // 31
          [13, 145, 115, 3, 146, 116],
          [2, 74, 46, 29, 75, 47],
          [42, 54, 24, 1, 55, 25],
          [23, 45, 15, 28, 46, 16],
          // 32
          [17, 145, 115],
          [10, 74, 46, 23, 75, 47],
          [10, 54, 24, 35, 55, 25],
          [19, 45, 15, 35, 46, 16],
          // 33
          [17, 145, 115, 1, 146, 116],
          [14, 74, 46, 21, 75, 47],
          [29, 54, 24, 19, 55, 25],
          [11, 45, 15, 46, 46, 16],
          // 34
          [13, 145, 115, 6, 146, 116],
          [14, 74, 46, 23, 75, 47],
          [44, 54, 24, 7, 55, 25],
          [59, 46, 16, 1, 47, 17],
          // 35
          [12, 151, 121, 7, 152, 122],
          [12, 75, 47, 26, 76, 48],
          [39, 54, 24, 14, 55, 25],
          [22, 45, 15, 41, 46, 16],
          // 36
          [6, 151, 121, 14, 152, 122],
          [6, 75, 47, 34, 76, 48],
          [46, 54, 24, 10, 55, 25],
          [2, 45, 15, 64, 46, 16],
          // 37
          [17, 152, 122, 4, 153, 123],
          [29, 74, 46, 14, 75, 47],
          [49, 54, 24, 10, 55, 25],
          [24, 45, 15, 46, 46, 16],
          // 38
          [4, 152, 122, 18, 153, 123],
          [13, 74, 46, 32, 75, 47],
          [48, 54, 24, 14, 55, 25],
          [42, 45, 15, 32, 46, 16],
          // 39
          [20, 147, 117, 4, 148, 118],
          [40, 75, 47, 7, 76, 48],
          [43, 54, 24, 22, 55, 25],
          [10, 45, 15, 67, 46, 16],
          // 40
          [19, 148, 118, 6, 149, 119],
          [18, 75, 47, 31, 76, 48],
          [34, 54, 24, 34, 55, 25],
          [20, 45, 15, 61, 46, 16]
        ];
        var qrRSBlock = function(totalCount, dataCount) {
          var _this2 = {};
          _this2.totalCount = totalCount;
          _this2.dataCount = dataCount;
          return _this2;
        };
        var _this = {};
        var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {
          switch (errorCorrectionLevel) {
            case QRErrorCorrectionLevel.L:
              return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
            case QRErrorCorrectionLevel.M:
              return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
            case QRErrorCorrectionLevel.Q:
              return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
            case QRErrorCorrectionLevel.H:
              return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
            default:
              return void 0;
          }
        };
        _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {
          var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
          if (typeof rsBlock == "undefined") {
            throw "bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel;
          }
          var length = rsBlock.length / 3;
          var list = [];
          for (var i = 0; i < length; i += 1) {
            var count = rsBlock[i * 3 + 0];
            var totalCount = rsBlock[i * 3 + 1];
            var dataCount = rsBlock[i * 3 + 2];
            for (var j = 0; j < count; j += 1) {
              list.push(qrRSBlock(totalCount, dataCount));
            }
          }
          return list;
        };
        return _this;
      }();
      var qrBitBuffer = function() {
        var _buffer = [];
        var _length = 0;
        var _this = {};
        _this.getBuffer = function() {
          return _buffer;
        };
        _this.getAt = function(index) {
          var bufIndex = Math.floor(index / 8);
          return (_buffer[bufIndex] >>> 7 - index % 8 & 1) == 1;
        };
        _this.put = function(num2, length) {
          for (var i = 0; i < length; i += 1) {
            _this.putBit((num2 >>> length - i - 1 & 1) == 1);
          }
        };
        _this.getLengthInBits = function() {
          return _length;
        };
        _this.putBit = function(bit) {
          var bufIndex = Math.floor(_length / 8);
          if (_buffer.length <= bufIndex) {
            _buffer.push(0);
          }
          if (bit) {
            _buffer[bufIndex] |= 128 >>> _length % 8;
          }
          _length += 1;
        };
        return _this;
      };
      var qrNumber = function(data) {
        var _mode = QRMode.MODE_NUMBER;
        var _data = data;
        var _this = {};
        _this.getMode = function() {
          return _mode;
        };
        _this.getLength = function(buffer) {
          return _data.length;
        };
        _this.write = function(buffer) {
          var data2 = _data;
          var i = 0;
          while (i + 2 < data2.length) {
            buffer.put(strToNum(data2.substring(i, i + 3)), 10);
            i += 3;
          }
          if (i < data2.length) {
            if (data2.length - i == 1) {
              buffer.put(strToNum(data2.substring(i, i + 1)), 4);
            } else if (data2.length - i == 2) {
              buffer.put(strToNum(data2.substring(i, i + 2)), 7);
            }
          }
        };
        var strToNum = function(s) {
          var num2 = 0;
          for (var i = 0; i < s.length; i += 1) {
            num2 = num2 * 10 + chatToNum(s.charAt(i));
          }
          return num2;
        };
        var chatToNum = function(c) {
          if ("0" <= c && c <= "9") {
            return c.charCodeAt(0) - "0".charCodeAt(0);
          }
          throw "illegal char :" + c;
        };
        return _this;
      };
      var qrAlphaNum = function(data) {
        var _mode = QRMode.MODE_ALPHA_NUM;
        var _data = data;
        var _this = {};
        _this.getMode = function() {
          return _mode;
        };
        _this.getLength = function(buffer) {
          return _data.length;
        };
        _this.write = function(buffer) {
          var s = _data;
          var i = 0;
          while (i + 1 < s.length) {
            buffer.put(
              getCode(s.charAt(i)) * 45 + getCode(s.charAt(i + 1)),
              11
            );
            i += 2;
          }
          if (i < s.length) {
            buffer.put(getCode(s.charAt(i)), 6);
          }
        };
        var getCode = function(c) {
          if ("0" <= c && c <= "9") {
            return c.charCodeAt(0) - "0".charCodeAt(0);
          } else if ("A" <= c && c <= "Z") {
            return c.charCodeAt(0) - "A".charCodeAt(0) + 10;
          } else {
            switch (c) {
              case " ":
                return 36;
              case "$":
                return 37;
              case "%":
                return 38;
              case "*":
                return 39;
              case "+":
                return 40;
              case "-":
                return 41;
              case ".":
                return 42;
              case "/":
                return 43;
              case ":":
                return 44;
              default:
                throw "illegal char :" + c;
            }
          }
        };
        return _this;
      };
      var qr8BitByte = function(data) {
        var _mode = QRMode.MODE_8BIT_BYTE;
        var _data = data;
        var _bytes = qrcode2.stringToBytes(data);
        var _this = {};
        _this.getMode = function() {
          return _mode;
        };
        _this.getLength = function(buffer) {
          return _bytes.length;
        };
        _this.write = function(buffer) {
          for (var i = 0; i < _bytes.length; i += 1) {
            buffer.put(_bytes[i], 8);
          }
        };
        return _this;
      };
      var qrKanji = function(data) {
        var _mode = QRMode.MODE_KANJI;
        var _data = data;
        var stringToBytes = qrcode2.stringToBytesFuncs["SJIS"];
        if (!stringToBytes) {
          throw "sjis not supported.";
        }
        !function(c, code) {
          var test = stringToBytes(c);
          if (test.length != 2 || (test[0] << 8 | test[1]) != code) {
            throw "sjis not supported.";
          }
        }("\u53CB", 38726);
        var _bytes = stringToBytes(data);
        var _this = {};
        _this.getMode = function() {
          return _mode;
        };
        _this.getLength = function(buffer) {
          return ~~(_bytes.length / 2);
        };
        _this.write = function(buffer) {
          var data2 = _bytes;
          var i = 0;
          while (i + 1 < data2.length) {
            var c = (255 & data2[i]) << 8 | 255 & data2[i + 1];
            if (33088 <= c && c <= 40956) {
              c -= 33088;
            } else if (57408 <= c && c <= 60351) {
              c -= 49472;
            } else {
              throw "illegal char at " + (i + 1) + "/" + c;
            }
            c = (c >>> 8 & 255) * 192 + (c & 255);
            buffer.put(c, 13);
            i += 2;
          }
          if (i < data2.length) {
            throw "illegal char at " + (i + 1);
          }
        };
        return _this;
      };
      var byteArrayOutputStream = function() {
        var _bytes = [];
        var _this = {};
        _this.writeByte = function(b) {
          _bytes.push(b & 255);
        };
        _this.writeShort = function(i) {
          _this.writeByte(i);
          _this.writeByte(i >>> 8);
        };
        _this.writeBytes = function(b, off, len) {
          off = off || 0;
          len = len || b.length;
          for (var i = 0; i < len; i += 1) {
            _this.writeByte(b[i + off]);
          }
        };
        _this.writeString = function(s) {
          for (var i = 0; i < s.length; i += 1) {
            _this.writeByte(s.charCodeAt(i));
          }
        };
        _this.toByteArray = function() {
          return _bytes;
        };
        _this.toString = function() {
          var s = "";
          s += "[";
          for (var i = 0; i < _bytes.length; i += 1) {
            if (i > 0) {
              s += ",";
            }
            s += _bytes[i];
          }
          s += "]";
          return s;
        };
        return _this;
      };
      var base64EncodeOutputStream = function() {
        var _buffer = 0;
        var _buflen = 0;
        var _length = 0;
        var _base64 = "";
        var _this = {};
        var writeEncoded = function(b) {
          _base64 += String.fromCharCode(encode(b & 63));
        };
        var encode = function(n) {
          if (n < 0) {
          } else if (n < 26) {
            return 65 + n;
          } else if (n < 52) {
            return 97 + (n - 26);
          } else if (n < 62) {
            return 48 + (n - 52);
          } else if (n == 62) {
            return 43;
          } else if (n == 63) {
            return 47;
          }
          throw "n:" + n;
        };
        _this.writeByte = function(n) {
          _buffer = _buffer << 8 | n & 255;
          _buflen += 8;
          _length += 1;
          while (_buflen >= 6) {
            writeEncoded(_buffer >>> _buflen - 6);
            _buflen -= 6;
          }
        };
        _this.flush = function() {
          if (_buflen > 0) {
            writeEncoded(_buffer << 6 - _buflen);
            _buffer = 0;
            _buflen = 0;
          }
          if (_length % 3 != 0) {
            var padlen = 3 - _length % 3;
            for (var i = 0; i < padlen; i += 1) {
              _base64 += "=";
            }
          }
        };
        _this.toString = function() {
          return _base64;
        };
        return _this;
      };
      var base64DecodeInputStream = function(str) {
        var _str = str;
        var _pos = 0;
        var _buffer = 0;
        var _buflen = 0;
        var _this = {};
        _this.read = function() {
          while (_buflen < 8) {
            if (_pos >= _str.length) {
              if (_buflen == 0) {
                return -1;
              }
              throw "unexpected end of file./" + _buflen;
            }
            var c = _str.charAt(_pos);
            _pos += 1;
            if (c == "=") {
              _buflen = 0;
              return -1;
            } else if (c.match(/^\s$/)) {
              continue;
            }
            _buffer = _buffer << 6 | decode(c.charCodeAt(0));
            _buflen += 6;
          }
          var n = _buffer >>> _buflen - 8 & 255;
          _buflen -= 8;
          return n;
        };
        var decode = function(c) {
          if (65 <= c && c <= 90) {
            return c - 65;
          } else if (97 <= c && c <= 122) {
            return c - 97 + 26;
          } else if (48 <= c && c <= 57) {
            return c - 48 + 52;
          } else if (c == 43) {
            return 62;
          } else if (c == 47) {
            return 63;
          } else {
            throw "c:" + c;
          }
        };
        return _this;
      };
      var gifImage = function(width, height) {
        var _width = width;
        var _height = height;
        var _data = new Array(width * height);
        var _this = {};
        _this.setPixel = function(x, y, pixel) {
          _data[y * _width + x] = pixel;
        };
        _this.write = function(out) {
          out.writeString("GIF87a");
          out.writeShort(_width);
          out.writeShort(_height);
          out.writeByte(128);
          out.writeByte(0);
          out.writeByte(0);
          out.writeByte(0);
          out.writeByte(0);
          out.writeByte(0);
          out.writeByte(255);
          out.writeByte(255);
          out.writeByte(255);
          out.writeString(",");
          out.writeShort(0);
          out.writeShort(0);
          out.writeShort(_width);
          out.writeShort(_height);
          out.writeByte(0);
          var lzwMinCodeSize = 2;
          var raster = getLZWRaster(lzwMinCodeSize);
          out.writeByte(lzwMinCodeSize);
          var offset = 0;
          while (raster.length - offset > 255) {
            out.writeByte(255);
            out.writeBytes(raster, offset, 255);
            offset += 255;
          }
          out.writeByte(raster.length - offset);
          out.writeBytes(raster, offset, raster.length - offset);
          out.writeByte(0);
          out.writeString(";");
        };
        var bitOutputStream = function(out) {
          var _out = out;
          var _bitLength = 0;
          var _bitBuffer = 0;
          var _this2 = {};
          _this2.write = function(data, length) {
            if (data >>> length != 0) {
              throw "length over";
            }
            while (_bitLength + length >= 8) {
              _out.writeByte(255 & (data << _bitLength | _bitBuffer));
              length -= 8 - _bitLength;
              data >>>= 8 - _bitLength;
              _bitBuffer = 0;
              _bitLength = 0;
            }
            _bitBuffer = data << _bitLength | _bitBuffer;
            _bitLength = _bitLength + length;
          };
          _this2.flush = function() {
            if (_bitLength > 0) {
              _out.writeByte(_bitBuffer);
            }
          };
          return _this2;
        };
        var getLZWRaster = function(lzwMinCodeSize) {
          var clearCode = 1 << lzwMinCodeSize;
          var endCode = (1 << lzwMinCodeSize) + 1;
          var bitLength = lzwMinCodeSize + 1;
          var table = lzwTable();
          for (var i = 0; i < clearCode; i += 1) {
            table.add(String.fromCharCode(i));
          }
          table.add(String.fromCharCode(clearCode));
          table.add(String.fromCharCode(endCode));
          var byteOut = byteArrayOutputStream();
          var bitOut = bitOutputStream(byteOut);
          bitOut.write(clearCode, bitLength);
          var dataIndex = 0;
          var s = String.fromCharCode(_data[dataIndex]);
          dataIndex += 1;
          while (dataIndex < _data.length) {
            var c = String.fromCharCode(_data[dataIndex]);
            dataIndex += 1;
            if (table.contains(s + c)) {
              s = s + c;
            } else {
              bitOut.write(table.indexOf(s), bitLength);
              if (table.size() < 4095) {
                if (table.size() == 1 << bitLength) {
                  bitLength += 1;
                }
                table.add(s + c);
              }
              s = c;
            }
          }
          bitOut.write(table.indexOf(s), bitLength);
          bitOut.write(endCode, bitLength);
          bitOut.flush();
          return byteOut.toByteArray();
        };
        var lzwTable = function() {
          var _map = {};
          var _size = 0;
          var _this2 = {};
          _this2.add = function(key) {
            if (_this2.contains(key)) {
              throw "dup key:" + key;
            }
            _map[key] = _size;
            _size += 1;
          };
          _this2.size = function() {
            return _size;
          };
          _this2.indexOf = function(key) {
            return _map[key];
          };
          _this2.contains = function(key) {
            return typeof _map[key] != "undefined";
          };
          return _this2;
        };
        return _this;
      };
      var createDataURL = function(width, height, getPixel) {
        var gif = gifImage(width, height);
        for (var y = 0; y < height; y += 1) {
          for (var x = 0; x < width; x += 1) {
            gif.setPixel(x, y, getPixel(x, y));
          }
        }
        var b = byteArrayOutputStream();
        gif.write(b);
        var base642 = base64EncodeOutputStream();
        var bytes = b.toByteArray();
        for (var i = 0; i < bytes.length; i += 1) {
          base642.writeByte(bytes[i]);
        }
        base642.flush();
        return "data:image/gif;base64," + base642;
      };
      return qrcode2;
    }();
    !function() {
      qrcode.stringToBytesFuncs["UTF-8"] = function(s) {
        function toUTF8Array(str) {
          var utf82 = [];
          for (var i = 0; i < str.length; i++) {
            var charcode = str.charCodeAt(i);
            if (charcode < 128) utf82.push(charcode);
            else if (charcode < 2048) {
              utf82.push(
                192 | charcode >> 6,
                128 | charcode & 63
              );
            } else if (charcode < 55296 || charcode >= 57344) {
              utf82.push(
                224 | charcode >> 12,
                128 | charcode >> 6 & 63,
                128 | charcode & 63
              );
            } else {
              i++;
              charcode = 65536 + ((charcode & 1023) << 10 | str.charCodeAt(i) & 1023);
              utf82.push(
                240 | charcode >> 18,
                128 | charcode >> 12 & 63,
                128 | charcode >> 6 & 63,
                128 | charcode & 63
              );
            }
          }
          return utf82;
        }
        return toUTF8Array(s);
      };
    }();
    (function(factory) {
      if (typeof define === "function" && define.amd) {
        define([], factory);
      } else if (typeof exports === "object") {
        module.exports = factory();
      }
    })(function() {
      return qrcode;
    });
  }
});

// node_modules/@noble/hashes/esm/crypto.js
var crypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

// node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash should be wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u8(arr) {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function rotl(word, shift) {
  return word << shift | word >>> 32 - shift >>> 0;
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
var swap8IfBE = isLE ? (n) => n : (n) => byteSwap(n);
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
var swap32IfBE = isLE ? (u) => u : byteSwap32;
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex2 = "";
  for (let i = 0; i < bytes.length; i++) {
    hex2 += hexes[bytes[i]];
  }
  return hex2;
}
var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex2) {
  if (typeof hex2 !== "string")
    throw new Error("hex string expected, got " + typeof hex2);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex2);
  const hl = hex2.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array2 = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex2.charCodeAt(hi));
    const n2 = asciiToBase16(hex2.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex2[hi] + hex2[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array2[ai] = n1 * 16 + n2;
  }
  return array2;
}
var nextTick = async () => {
};
async function asyncLoop(iters, tick, cb) {
  let ts = Date.now();
  for (let i = 0; i < iters; i++) {
    cb(i);
    const diff = Date.now() - ts;
    if (diff >= 0 && diff < tick)
      continue;
    await nextTick();
    ts += diff;
  }
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
function kdfInputToBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function checkOpts(defaults, opts) {
  if (opts !== void 0 && {}.toString.call(opts) !== "[object Object]")
    throw new Error("options should be object or undefined");
  const merged = Object.assign(defaults, opts);
  return merged;
}
var Hash = class {
};
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function createOptHasher(hashCons) {
  const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
  const tmp = hashCons({});
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (opts) => hashCons(opts);
  return hashC;
}
function randomBytes(bytesLength = 32) {
  if (crypto && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto && typeof crypto.randomBytes === "function") {
    return Uint8Array.from(crypto.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}

// node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view2, byteOffset, value, isLE2) {
  if (typeof view2.setBigUint64 === "function")
    return view2.setBigUint64(byteOffset, value, isLE2);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE2 ? 4 : 0;
  const l = isLE2 ? 0 : 4;
  view2.setUint32(byteOffset + h, wh, isLE2);
  view2.setUint32(byteOffset + l, wl, isLE2);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE2) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE2;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { view: view2, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view2, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view: view2, blockLen, isLE: isLE2 } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view2, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint64(view2, blockLen - 8, BigInt(this.length * 8), isLE2);
    this.process(view2, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE2);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// node_modules/@noble/hashes/esm/_u64.js
var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var shrSH = (h, _l, s) => h >>> s;
var shrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
var rotr32H = (_h, l) => l;
var rotr32L = (h, _l) => h;
var rotlSH = (h, l, s) => h << s | l >>> 32 - s;
var rotlSL = (h, l, s) => l << s | h >>> 32 - s;
var rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
var rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// node_modules/@noble/hashes/esm/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA256 = class extends HashMD {
  constructor(outputLen = 32) {
    super(64, outputLen, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G: G2, H } = this;
    return [A, B, C, D, E, F, G2, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G2, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G2 | 0;
    this.H = H | 0;
  }
  process(view2, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view2.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G: G2, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G2) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G2;
      G2 = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G2 = G2 + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G2, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
var SHA512 = class extends HashMD {
  constructor(outputLen = 64) {
    super(128, outputLen, 16, false);
    this.Ah = SHA512_IV[0] | 0;
    this.Al = SHA512_IV[1] | 0;
    this.Bh = SHA512_IV[2] | 0;
    this.Bl = SHA512_IV[3] | 0;
    this.Ch = SHA512_IV[4] | 0;
    this.Cl = SHA512_IV[5] | 0;
    this.Dh = SHA512_IV[6] | 0;
    this.Dl = SHA512_IV[7] | 0;
    this.Eh = SHA512_IV[8] | 0;
    this.El = SHA512_IV[9] | 0;
    this.Fh = SHA512_IV[10] | 0;
    this.Fl = SHA512_IV[11] | 0;
    this.Gh = SHA512_IV[12] | 0;
    this.Gl = SHA512_IV[13] | 0;
    this.Hh = SHA512_IV[14] | 0;
    this.Hl = SHA512_IV[15] | 0;
  }
  // prettier-ignore
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  // prettier-ignore
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  process(view2, offset) {
    for (let i = 0; i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view2.getUint32(offset);
      SHA512_W_L[i] = view2.getUint32(offset += 4);
    }
    for (let i = 16; i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0; i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var sha256 = /* @__PURE__ */ createHasher(() => new SHA256());
var sha512 = /* @__PURE__ */ createHasher(() => new SHA512());

// node_modules/@noble/hashes/esm/sha3.js
var _0n = BigInt(0);
var _1n = BigInt(1);
var _2n = BigInt(2);
var _7n = BigInt(7);
var _256n = BigInt(256);
var _0x71n = BigInt(113);
var SHA3_PI = [];
var SHA3_ROTL = [];
var _SHA3_IOTA = [];
for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
  [x, y] = [y, (2 * x + 3 * y) % 5];
  SHA3_PI.push(2 * (5 * y + x));
  SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
  let t = _0n;
  for (let j = 0; j < 7; j++) {
    R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
    if (R & _2n)
      t ^= _1n << (_1n << /* @__PURE__ */ BigInt(j)) - _1n;
  }
  _SHA3_IOTA.push(t);
}
var IOTAS = split(_SHA3_IOTA, true);
var SHA3_IOTA_H = IOTAS[0];
var SHA3_IOTA_L = IOTAS[1];
var rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s);
var rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s);
function keccakP(s, rounds = 24) {
  const B = new Uint32Array(5 * 2);
  for (let round = 24 - rounds; round < 24; round++) {
    for (let x = 0; x < 10; x++)
      B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0; y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0; t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 10; x++)
        B[x] = s[y + x];
      for (let x = 0; x < 10; x++)
        s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
  clean(B);
}
var Keccak = class _Keccak extends Hash {
  // NOTE: we accept arguments in bytes instead of bits here.
  constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
    super();
    this.pos = 0;
    this.posOut = 0;
    this.finished = false;
    this.destroyed = false;
    this.enableXOF = false;
    this.blockLen = blockLen;
    this.suffix = suffix;
    this.outputLen = outputLen;
    this.enableXOF = enableXOF;
    this.rounds = rounds;
    anumber(outputLen);
    if (!(0 < blockLen && blockLen < 200))
      throw new Error("only keccak-f1600 function is supported");
    this.state = new Uint8Array(200);
    this.state32 = u32(this.state);
  }
  clone() {
    return this._cloneInto();
  }
  keccak() {
    swap32IfBE(this.state32);
    keccakP(this.state32, this.rounds);
    swap32IfBE(this.state32);
    this.posOut = 0;
    this.pos = 0;
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { blockLen, state } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      for (let i = 0; i < take; i++)
        state[this.pos++] ^= data[pos++];
      if (this.pos === blockLen)
        this.keccak();
    }
    return this;
  }
  finish() {
    if (this.finished)
      return;
    this.finished = true;
    const { state, suffix, pos, blockLen } = this;
    state[pos] ^= suffix;
    if ((suffix & 128) !== 0 && pos === blockLen - 1)
      this.keccak();
    state[blockLen - 1] ^= 128;
    this.keccak();
  }
  writeInto(out) {
    aexists(this, false);
    abytes(out);
    this.finish();
    const bufferOut = this.state;
    const { blockLen } = this;
    for (let pos = 0, len = out.length; pos < len; ) {
      if (this.posOut >= blockLen)
        this.keccak();
      const take = Math.min(blockLen - this.posOut, len - pos);
      out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
      this.posOut += take;
      pos += take;
    }
    return out;
  }
  xofInto(out) {
    if (!this.enableXOF)
      throw new Error("XOF is not possible for this instance");
    return this.writeInto(out);
  }
  xof(bytes) {
    anumber(bytes);
    return this.xofInto(new Uint8Array(bytes));
  }
  digestInto(out) {
    aoutput(out, this);
    if (this.finished)
      throw new Error("digest() was already called");
    this.writeInto(out);
    this.destroy();
    return out;
  }
  digest() {
    return this.digestInto(new Uint8Array(this.outputLen));
  }
  destroy() {
    this.destroyed = true;
    clean(this.state);
  }
  _cloneInto(to) {
    const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
    to || (to = new _Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
    to.state32.set(this.state32);
    to.pos = this.pos;
    to.posOut = this.posOut;
    to.finished = this.finished;
    to.rounds = rounds;
    to.suffix = suffix;
    to.outputLen = outputLen;
    to.enableXOF = enableXOF;
    to.destroyed = this.destroyed;
    return to;
  }
};
var gen = (suffix, blockLen, outputLen) => createHasher(() => new Keccak(blockLen, suffix, outputLen));
var keccak_256 = /* @__PURE__ */ (() => gen(1, 136, 256 / 8))();

// node_modules/@noble/hashes/esm/legacy.js
var Rho160 = /* @__PURE__ */ Uint8Array.from([
  7,
  4,
  13,
  1,
  10,
  6,
  15,
  3,
  12,
  0,
  9,
  5,
  2,
  14,
  11,
  8
]);
var Id160 = /* @__PURE__ */ (() => Uint8Array.from(new Array(16).fill(0).map((_, i) => i)))();
var Pi160 = /* @__PURE__ */ (() => Id160.map((i) => (9 * i + 5) % 16))();
var idxLR = /* @__PURE__ */ (() => {
  const L = [Id160];
  const R = [Pi160];
  const res = [L, R];
  for (let i = 0; i < 4; i++)
    for (let j of res)
      j.push(j[i].map((k) => Rho160[k]));
  return res;
})();
var idxL = /* @__PURE__ */ (() => idxLR[0])();
var idxR = /* @__PURE__ */ (() => idxLR[1])();
var shifts160 = /* @__PURE__ */ [
  [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],
  [12, 13, 11, 15, 6, 9, 9, 7, 12, 15, 11, 13, 7, 8, 7, 7],
  [13, 15, 14, 11, 7, 7, 6, 8, 13, 14, 13, 12, 5, 5, 6, 9],
  [14, 11, 12, 14, 8, 6, 5, 5, 15, 12, 15, 14, 9, 9, 8, 6],
  [15, 12, 13, 13, 9, 5, 8, 6, 14, 11, 12, 11, 8, 6, 5, 5]
].map((i) => Uint8Array.from(i));
var shiftsL160 = /* @__PURE__ */ idxL.map((idx, i) => idx.map((j) => shifts160[i][j]));
var shiftsR160 = /* @__PURE__ */ idxR.map((idx, i) => idx.map((j) => shifts160[i][j]));
var Kl160 = /* @__PURE__ */ Uint32Array.from([
  0,
  1518500249,
  1859775393,
  2400959708,
  2840853838
]);
var Kr160 = /* @__PURE__ */ Uint32Array.from([
  1352829926,
  1548603684,
  1836072691,
  2053994217,
  0
]);
function ripemd_f(group, x, y, z) {
  if (group === 0)
    return x ^ y ^ z;
  if (group === 1)
    return x & y | ~x & z;
  if (group === 2)
    return (x | ~y) ^ z;
  if (group === 3)
    return x & z | y & ~z;
  return x ^ (y | ~z);
}
var BUF_160 = /* @__PURE__ */ new Uint32Array(16);
var RIPEMD160 = class extends HashMD {
  constructor() {
    super(64, 20, 8, true);
    this.h0 = 1732584193 | 0;
    this.h1 = 4023233417 | 0;
    this.h2 = 2562383102 | 0;
    this.h3 = 271733878 | 0;
    this.h4 = 3285377520 | 0;
  }
  get() {
    const { h0, h1, h2, h3, h4 } = this;
    return [h0, h1, h2, h3, h4];
  }
  set(h0, h1, h2, h3, h4) {
    this.h0 = h0 | 0;
    this.h1 = h1 | 0;
    this.h2 = h2 | 0;
    this.h3 = h3 | 0;
    this.h4 = h4 | 0;
  }
  process(view2, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      BUF_160[i] = view2.getUint32(offset, true);
    let al = this.h0 | 0, ar = al, bl = this.h1 | 0, br = bl, cl = this.h2 | 0, cr = cl, dl = this.h3 | 0, dr = dl, el = this.h4 | 0, er = el;
    for (let group = 0; group < 5; group++) {
      const rGroup = 4 - group;
      const hbl = Kl160[group], hbr = Kr160[group];
      const rl = idxL[group], rr = idxR[group];
      const sl = shiftsL160[group], sr = shiftsR160[group];
      for (let i = 0; i < 16; i++) {
        const tl = rotl(al + ripemd_f(group, bl, cl, dl) + BUF_160[rl[i]] + hbl, sl[i]) + el | 0;
        al = el, el = dl, dl = rotl(cl, 10) | 0, cl = bl, bl = tl;
      }
      for (let i = 0; i < 16; i++) {
        const tr = rotl(ar + ripemd_f(rGroup, br, cr, dr) + BUF_160[rr[i]] + hbr, sr[i]) + er | 0;
        ar = er, er = dr, dr = rotl(cr, 10) | 0, cr = br, br = tr;
      }
    }
    this.set(this.h1 + cl + dr | 0, this.h2 + dl + er | 0, this.h3 + el + ar | 0, this.h4 + al + br | 0, this.h0 + bl + cr | 0);
  }
  roundClean() {
    clean(BUF_160);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0);
  }
};
var ripemd160 = /* @__PURE__ */ createHasher(() => new RIPEMD160());

// node_modules/@noble/hashes/esm/hmac.js
var HMAC = class extends Hash {
  constructor(hash, _key) {
    super();
    this.finished = false;
    this.destroyed = false;
    ahash(hash);
    const key = toBytes(_key);
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    abytes(out, this.outputLen);
    this.finished = true;
    this.iHash.digestInto(out);
    this.oHash.update(out);
    this.oHash.digestInto(out);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to || (to = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new HMAC(hash, key);

// node_modules/@noble/hashes/esm/_blake.js
var BSIGMA = /* @__PURE__ */ Uint8Array.from([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  14,
  10,
  4,
  8,
  9,
  15,
  13,
  6,
  1,
  12,
  0,
  2,
  11,
  7,
  5,
  3,
  11,
  8,
  12,
  0,
  5,
  2,
  15,
  13,
  10,
  14,
  3,
  6,
  7,
  1,
  9,
  4,
  7,
  9,
  3,
  1,
  13,
  12,
  11,
  14,
  2,
  6,
  5,
  10,
  4,
  0,
  15,
  8,
  9,
  0,
  5,
  7,
  2,
  4,
  10,
  15,
  14,
  1,
  11,
  12,
  6,
  8,
  3,
  13,
  2,
  12,
  6,
  10,
  0,
  11,
  8,
  3,
  4,
  13,
  7,
  5,
  15,
  14,
  1,
  9,
  12,
  5,
  1,
  15,
  14,
  13,
  4,
  10,
  0,
  7,
  6,
  3,
  9,
  2,
  8,
  11,
  13,
  11,
  7,
  14,
  12,
  1,
  3,
  9,
  5,
  0,
  15,
  4,
  8,
  6,
  2,
  10,
  6,
  15,
  14,
  9,
  11,
  3,
  0,
  8,
  12,
  2,
  13,
  7,
  1,
  4,
  10,
  5,
  10,
  2,
  8,
  4,
  7,
  6,
  1,
  5,
  15,
  11,
  9,
  14,
  3,
  12,
  13,
  0,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  14,
  10,
  4,
  8,
  9,
  15,
  13,
  6,
  1,
  12,
  0,
  2,
  11,
  7,
  5,
  3,
  // Blake1, unused in others
  11,
  8,
  12,
  0,
  5,
  2,
  15,
  13,
  10,
  14,
  3,
  6,
  7,
  1,
  9,
  4,
  7,
  9,
  3,
  1,
  13,
  12,
  11,
  14,
  2,
  6,
  5,
  10,
  4,
  0,
  15,
  8,
  9,
  0,
  5,
  7,
  2,
  4,
  10,
  15,
  14,
  1,
  11,
  12,
  6,
  8,
  3,
  13,
  2,
  12,
  6,
  10,
  0,
  11,
  8,
  3,
  4,
  13,
  7,
  5,
  15,
  14,
  1,
  9
]);

// node_modules/@noble/hashes/esm/blake2.js
var B2B_IV = /* @__PURE__ */ Uint32Array.from([
  4089235720,
  1779033703,
  2227873595,
  3144134277,
  4271175723,
  1013904242,
  1595750129,
  2773480762,
  2917565137,
  1359893119,
  725511199,
  2600822924,
  4215389547,
  528734635,
  327033209,
  1541459225
]);
var BBUF = /* @__PURE__ */ new Uint32Array(32);
function G1b(a, b, c, d, msg, x) {
  const Xl = msg[x], Xh = msg[x + 1];
  let Al = BBUF[2 * a], Ah = BBUF[2 * a + 1];
  let Bl = BBUF[2 * b], Bh = BBUF[2 * b + 1];
  let Cl = BBUF[2 * c], Ch = BBUF[2 * c + 1];
  let Dl = BBUF[2 * d], Dh = BBUF[2 * d + 1];
  let ll = add3L(Al, Bl, Xl);
  Ah = add3H(ll, Ah, Bh, Xh);
  Al = ll | 0;
  ({ Dh, Dl } = { Dh: Dh ^ Ah, Dl: Dl ^ Al });
  ({ Dh, Dl } = { Dh: rotr32H(Dh, Dl), Dl: rotr32L(Dh, Dl) });
  ({ h: Ch, l: Cl } = add(Ch, Cl, Dh, Dl));
  ({ Bh, Bl } = { Bh: Bh ^ Ch, Bl: Bl ^ Cl });
  ({ Bh, Bl } = { Bh: rotrSH(Bh, Bl, 24), Bl: rotrSL(Bh, Bl, 24) });
  BBUF[2 * a] = Al, BBUF[2 * a + 1] = Ah;
  BBUF[2 * b] = Bl, BBUF[2 * b + 1] = Bh;
  BBUF[2 * c] = Cl, BBUF[2 * c + 1] = Ch;
  BBUF[2 * d] = Dl, BBUF[2 * d + 1] = Dh;
}
function G2b(a, b, c, d, msg, x) {
  const Xl = msg[x], Xh = msg[x + 1];
  let Al = BBUF[2 * a], Ah = BBUF[2 * a + 1];
  let Bl = BBUF[2 * b], Bh = BBUF[2 * b + 1];
  let Cl = BBUF[2 * c], Ch = BBUF[2 * c + 1];
  let Dl = BBUF[2 * d], Dh = BBUF[2 * d + 1];
  let ll = add3L(Al, Bl, Xl);
  Ah = add3H(ll, Ah, Bh, Xh);
  Al = ll | 0;
  ({ Dh, Dl } = { Dh: Dh ^ Ah, Dl: Dl ^ Al });
  ({ Dh, Dl } = { Dh: rotrSH(Dh, Dl, 16), Dl: rotrSL(Dh, Dl, 16) });
  ({ h: Ch, l: Cl } = add(Ch, Cl, Dh, Dl));
  ({ Bh, Bl } = { Bh: Bh ^ Ch, Bl: Bl ^ Cl });
  ({ Bh, Bl } = { Bh: rotrBH(Bh, Bl, 63), Bl: rotrBL(Bh, Bl, 63) });
  BBUF[2 * a] = Al, BBUF[2 * a + 1] = Ah;
  BBUF[2 * b] = Bl, BBUF[2 * b + 1] = Bh;
  BBUF[2 * c] = Cl, BBUF[2 * c + 1] = Ch;
  BBUF[2 * d] = Dl, BBUF[2 * d + 1] = Dh;
}
function checkBlake2Opts(outputLen, opts = {}, keyLen, saltLen, persLen) {
  anumber(keyLen);
  if (outputLen < 0 || outputLen > keyLen)
    throw new Error("outputLen bigger than keyLen");
  const { key, salt, personalization } = opts;
  if (key !== void 0 && (key.length < 1 || key.length > keyLen))
    throw new Error("key length must be undefined or 1.." + keyLen);
  if (salt !== void 0 && salt.length !== saltLen)
    throw new Error("salt must be undefined or " + saltLen);
  if (personalization !== void 0 && personalization.length !== persLen)
    throw new Error("personalization must be undefined or " + persLen);
}
var BLAKE2 = class extends Hash {
  constructor(blockLen, outputLen) {
    super();
    this.finished = false;
    this.destroyed = false;
    this.length = 0;
    this.pos = 0;
    anumber(blockLen);
    anumber(outputLen);
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.buffer = new Uint8Array(blockLen);
    this.buffer32 = u32(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { blockLen, buffer, buffer32 } = this;
    const len = data.length;
    const offset = data.byteOffset;
    const buf = data.buffer;
    for (let pos = 0; pos < len; ) {
      if (this.pos === blockLen) {
        swap32IfBE(buffer32);
        this.compress(buffer32, 0, false);
        swap32IfBE(buffer32);
        this.pos = 0;
      }
      const take = Math.min(blockLen - this.pos, len - pos);
      const dataOffset = offset + pos;
      if (take === blockLen && !(dataOffset % 4) && pos + take < len) {
        const data32 = new Uint32Array(buf, dataOffset, Math.floor((len - pos) / 4));
        swap32IfBE(data32);
        for (let pos32 = 0; pos + blockLen < len; pos32 += buffer32.length, pos += blockLen) {
          this.length += blockLen;
          this.compress(data32, pos32, false);
        }
        swap32IfBE(data32);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      this.length += take;
      pos += take;
    }
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    const { pos, buffer32 } = this;
    this.finished = true;
    clean(this.buffer.subarray(pos));
    swap32IfBE(buffer32);
    this.compress(buffer32, 0, true);
    swap32IfBE(buffer32);
    const out32 = u32(out);
    this.get().forEach((v, i) => out32[i] = swap8IfBE(v));
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    const { buffer, length, finished, destroyed, outputLen, pos } = this;
    to || (to = new this.constructor({ dkLen: outputLen }));
    to.set(...this.get());
    to.buffer.set(buffer);
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    to.outputLen = outputLen;
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var BLAKE2b = class extends BLAKE2 {
  constructor(opts = {}) {
    const olen = opts.dkLen === void 0 ? 64 : opts.dkLen;
    super(128, olen);
    this.v0l = B2B_IV[0] | 0;
    this.v0h = B2B_IV[1] | 0;
    this.v1l = B2B_IV[2] | 0;
    this.v1h = B2B_IV[3] | 0;
    this.v2l = B2B_IV[4] | 0;
    this.v2h = B2B_IV[5] | 0;
    this.v3l = B2B_IV[6] | 0;
    this.v3h = B2B_IV[7] | 0;
    this.v4l = B2B_IV[8] | 0;
    this.v4h = B2B_IV[9] | 0;
    this.v5l = B2B_IV[10] | 0;
    this.v5h = B2B_IV[11] | 0;
    this.v6l = B2B_IV[12] | 0;
    this.v6h = B2B_IV[13] | 0;
    this.v7l = B2B_IV[14] | 0;
    this.v7h = B2B_IV[15] | 0;
    checkBlake2Opts(olen, opts, 64, 16, 16);
    let { key, personalization, salt } = opts;
    let keyLength = 0;
    if (key !== void 0) {
      key = toBytes(key);
      keyLength = key.length;
    }
    this.v0l ^= this.outputLen | keyLength << 8 | 1 << 16 | 1 << 24;
    if (salt !== void 0) {
      salt = toBytes(salt);
      const slt = u32(salt);
      this.v4l ^= swap8IfBE(slt[0]);
      this.v4h ^= swap8IfBE(slt[1]);
      this.v5l ^= swap8IfBE(slt[2]);
      this.v5h ^= swap8IfBE(slt[3]);
    }
    if (personalization !== void 0) {
      personalization = toBytes(personalization);
      const pers = u32(personalization);
      this.v6l ^= swap8IfBE(pers[0]);
      this.v6h ^= swap8IfBE(pers[1]);
      this.v7l ^= swap8IfBE(pers[2]);
      this.v7h ^= swap8IfBE(pers[3]);
    }
    if (key !== void 0) {
      const tmp = new Uint8Array(this.blockLen);
      tmp.set(key);
      this.update(tmp);
    }
  }
  // prettier-ignore
  get() {
    let { v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h } = this;
    return [v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h];
  }
  // prettier-ignore
  set(v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h) {
    this.v0l = v0l | 0;
    this.v0h = v0h | 0;
    this.v1l = v1l | 0;
    this.v1h = v1h | 0;
    this.v2l = v2l | 0;
    this.v2h = v2h | 0;
    this.v3l = v3l | 0;
    this.v3h = v3h | 0;
    this.v4l = v4l | 0;
    this.v4h = v4h | 0;
    this.v5l = v5l | 0;
    this.v5h = v5h | 0;
    this.v6l = v6l | 0;
    this.v6h = v6h | 0;
    this.v7l = v7l | 0;
    this.v7h = v7h | 0;
  }
  compress(msg, offset, isLast) {
    this.get().forEach((v, i) => BBUF[i] = v);
    BBUF.set(B2B_IV, 16);
    let { h, l } = fromBig(BigInt(this.length));
    BBUF[24] = B2B_IV[8] ^ l;
    BBUF[25] = B2B_IV[9] ^ h;
    if (isLast) {
      BBUF[28] = ~BBUF[28];
      BBUF[29] = ~BBUF[29];
    }
    let j = 0;
    const s = BSIGMA;
    for (let i = 0; i < 12; i++) {
      G1b(0, 4, 8, 12, msg, offset + 2 * s[j++]);
      G2b(0, 4, 8, 12, msg, offset + 2 * s[j++]);
      G1b(1, 5, 9, 13, msg, offset + 2 * s[j++]);
      G2b(1, 5, 9, 13, msg, offset + 2 * s[j++]);
      G1b(2, 6, 10, 14, msg, offset + 2 * s[j++]);
      G2b(2, 6, 10, 14, msg, offset + 2 * s[j++]);
      G1b(3, 7, 11, 15, msg, offset + 2 * s[j++]);
      G2b(3, 7, 11, 15, msg, offset + 2 * s[j++]);
      G1b(0, 5, 10, 15, msg, offset + 2 * s[j++]);
      G2b(0, 5, 10, 15, msg, offset + 2 * s[j++]);
      G1b(1, 6, 11, 12, msg, offset + 2 * s[j++]);
      G2b(1, 6, 11, 12, msg, offset + 2 * s[j++]);
      G1b(2, 7, 8, 13, msg, offset + 2 * s[j++]);
      G2b(2, 7, 8, 13, msg, offset + 2 * s[j++]);
      G1b(3, 4, 9, 14, msg, offset + 2 * s[j++]);
      G2b(3, 4, 9, 14, msg, offset + 2 * s[j++]);
    }
    this.v0l ^= BBUF[0] ^ BBUF[16];
    this.v0h ^= BBUF[1] ^ BBUF[17];
    this.v1l ^= BBUF[2] ^ BBUF[18];
    this.v1h ^= BBUF[3] ^ BBUF[19];
    this.v2l ^= BBUF[4] ^ BBUF[20];
    this.v2h ^= BBUF[5] ^ BBUF[21];
    this.v3l ^= BBUF[6] ^ BBUF[22];
    this.v3h ^= BBUF[7] ^ BBUF[23];
    this.v4l ^= BBUF[8] ^ BBUF[24];
    this.v4h ^= BBUF[9] ^ BBUF[25];
    this.v5l ^= BBUF[10] ^ BBUF[26];
    this.v5h ^= BBUF[11] ^ BBUF[27];
    this.v6l ^= BBUF[12] ^ BBUF[28];
    this.v6h ^= BBUF[13] ^ BBUF[29];
    this.v7l ^= BBUF[14] ^ BBUF[30];
    this.v7h ^= BBUF[15] ^ BBUF[31];
    clean(BBUF);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer32);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var blake2b = /* @__PURE__ */ createOptHasher((opts) => new BLAKE2b(opts));

// node_modules/@noble/hashes/esm/argon2.js
var AT = { Argond2d: 0, Argon2i: 1, Argon2id: 2 };
var ARGON2_SYNC_POINTS = 4;
var abytesOrZero = (buf) => {
  if (buf === void 0)
    return Uint8Array.of();
  return kdfInputToBytes(buf);
};
function mul(a, b) {
  const aL = a & 65535;
  const aH = a >>> 16;
  const bL = b & 65535;
  const bH = b >>> 16;
  const ll = Math.imul(aL, bL);
  const hl = Math.imul(aH, bL);
  const lh = Math.imul(aL, bH);
  const hh = Math.imul(aH, bH);
  const carry = (ll >>> 16) + (hl & 65535) + lh;
  const high = hh + (hl >>> 16) + (carry >>> 16) | 0;
  const low = carry << 16 | ll & 65535;
  return { h: high, l: low };
}
function mul2(a, b) {
  const { h, l } = mul(a, b);
  return { h: (h << 1 | l >>> 31) & 4294967295, l: l << 1 & 4294967295 };
}
function blamka(Ah, Al, Bh, Bl) {
  const { h: Ch, l: Cl } = mul2(Al, Bl);
  const Rll = add3L(Al, Bl, Cl);
  return { h: add3H(Rll, Ah, Bh, Ch), l: Rll | 0 };
}
var A2_BUF = new Uint32Array(256);
function G(a, b, c, d) {
  let Al = A2_BUF[2 * a], Ah = A2_BUF[2 * a + 1];
  let Bl = A2_BUF[2 * b], Bh = A2_BUF[2 * b + 1];
  let Cl = A2_BUF[2 * c], Ch = A2_BUF[2 * c + 1];
  let Dl = A2_BUF[2 * d], Dh = A2_BUF[2 * d + 1];
  ({ h: Ah, l: Al } = blamka(Ah, Al, Bh, Bl));
  ({ Dh, Dl } = { Dh: Dh ^ Ah, Dl: Dl ^ Al });
  ({ Dh, Dl } = { Dh: rotr32H(Dh, Dl), Dl: rotr32L(Dh, Dl) });
  ({ h: Ch, l: Cl } = blamka(Ch, Cl, Dh, Dl));
  ({ Bh, Bl } = { Bh: Bh ^ Ch, Bl: Bl ^ Cl });
  ({ Bh, Bl } = { Bh: rotrSH(Bh, Bl, 24), Bl: rotrSL(Bh, Bl, 24) });
  ({ h: Ah, l: Al } = blamka(Ah, Al, Bh, Bl));
  ({ Dh, Dl } = { Dh: Dh ^ Ah, Dl: Dl ^ Al });
  ({ Dh, Dl } = { Dh: rotrSH(Dh, Dl, 16), Dl: rotrSL(Dh, Dl, 16) });
  ({ h: Ch, l: Cl } = blamka(Ch, Cl, Dh, Dl));
  ({ Bh, Bl } = { Bh: Bh ^ Ch, Bl: Bl ^ Cl });
  ({ Bh, Bl } = { Bh: rotrBH(Bh, Bl, 63), Bl: rotrBL(Bh, Bl, 63) });
  A2_BUF[2 * a] = Al, A2_BUF[2 * a + 1] = Ah;
  A2_BUF[2 * b] = Bl, A2_BUF[2 * b + 1] = Bh;
  A2_BUF[2 * c] = Cl, A2_BUF[2 * c + 1] = Ch;
  A2_BUF[2 * d] = Dl, A2_BUF[2 * d + 1] = Dh;
}
function P(v00, v01, v02, v03, v04, v05, v06, v07, v08, v09, v10, v11, v12, v13, v14, v15) {
  G(v00, v04, v08, v12);
  G(v01, v05, v09, v13);
  G(v02, v06, v10, v14);
  G(v03, v07, v11, v15);
  G(v00, v05, v10, v15);
  G(v01, v06, v11, v12);
  G(v02, v07, v08, v13);
  G(v03, v04, v09, v14);
}
function block(x, xPos, yPos, outPos, needXor) {
  for (let i = 0; i < 256; i++)
    A2_BUF[i] = x[xPos + i] ^ x[yPos + i];
  for (let i = 0; i < 128; i += 16) {
    P(i, i + 1, i + 2, i + 3, i + 4, i + 5, i + 6, i + 7, i + 8, i + 9, i + 10, i + 11, i + 12, i + 13, i + 14, i + 15);
  }
  for (let i = 0; i < 16; i += 2) {
    P(i, i + 1, i + 16, i + 17, i + 32, i + 33, i + 48, i + 49, i + 64, i + 65, i + 80, i + 81, i + 96, i + 97, i + 112, i + 113);
  }
  if (needXor)
    for (let i = 0; i < 256; i++)
      x[outPos + i] ^= A2_BUF[i] ^ x[xPos + i] ^ x[yPos + i];
  else
    for (let i = 0; i < 256; i++)
      x[outPos + i] = A2_BUF[i] ^ x[xPos + i] ^ x[yPos + i];
  clean(A2_BUF);
}
function Hp(A, dkLen) {
  const A8 = u8(A);
  const T = new Uint32Array(1);
  const T8 = u8(T);
  T[0] = dkLen;
  if (dkLen <= 64)
    return blake2b.create({ dkLen }).update(T8).update(A8).digest();
  const out = new Uint8Array(dkLen);
  let V = blake2b.create({}).update(T8).update(A8).digest();
  let pos = 0;
  out.set(V.subarray(0, 32));
  pos += 32;
  for (; dkLen - pos > 64; pos += 32) {
    const Vh = blake2b.create({}).update(V);
    Vh.digestInto(V);
    Vh.destroy();
    out.set(V.subarray(0, 32), pos);
  }
  out.set(blake2b(V, { dkLen: dkLen - pos }), pos);
  clean(V, T);
  return u32(out);
}
function indexAlpha(r, s, laneLen, segmentLen, index, randL, sameLane = false) {
  let area;
  if (r === 0) {
    if (s === 0)
      area = index - 1;
    else if (sameLane)
      area = s * segmentLen + index - 1;
    else
      area = s * segmentLen + (index == 0 ? -1 : 0);
  } else if (sameLane)
    area = laneLen - segmentLen + index - 1;
  else
    area = laneLen - segmentLen + (index == 0 ? -1 : 0);
  const startPos = r !== 0 && s !== ARGON2_SYNC_POINTS - 1 ? (s + 1) * segmentLen : 0;
  const rel = area - 1 - mul(area, mul(randL, randL).h).h;
  return (startPos + rel) % laneLen;
}
var maxUint32 = Math.pow(2, 32);
function isU32(num2) {
  return Number.isSafeInteger(num2) && num2 >= 0 && num2 < maxUint32;
}
function argon2Opts(opts) {
  const merged = {
    version: 19,
    dkLen: 32,
    maxmem: maxUint32 - 1,
    asyncTick: 10
  };
  for (let [k, v] of Object.entries(opts))
    if (v != null)
      merged[k] = v;
  const { dkLen, p, m, t, version, onProgress } = merged;
  if (!isU32(dkLen) || dkLen < 4)
    throw new Error("dkLen should be at least 4 bytes");
  if (!isU32(p) || p < 1 || p >= Math.pow(2, 24))
    throw new Error("p should be 1 <= p < 2^24");
  if (!isU32(m))
    throw new Error("m should be 0 <= m < 2^32");
  if (!isU32(t) || t < 1)
    throw new Error("t (iterations) should be 1 <= t < 2^32");
  if (onProgress !== void 0 && typeof onProgress !== "function")
    throw new Error("progressCb should be function");
  if (!isU32(m) || m < 8 * p)
    throw new Error("memory should be at least 8*p bytes");
  if (version !== 16 && version !== 19)
    throw new Error("unknown version=" + version);
  return merged;
}
function argon2Init(password, salt, type, opts) {
  password = kdfInputToBytes(password);
  salt = kdfInputToBytes(salt);
  abytes(password);
  abytes(salt);
  if (!isU32(password.length))
    throw new Error("password should be less than 4 GB");
  if (!isU32(salt.length) || salt.length < 8)
    throw new Error("salt should be at least 8 bytes and less than 4 GB");
  if (!Object.values(AT).includes(type))
    throw new Error("invalid type");
  let { p, dkLen, m, t, version, key, personalization, maxmem, onProgress, asyncTick } = argon2Opts(opts);
  key = abytesOrZero(key);
  personalization = abytesOrZero(personalization);
  const h = blake2b.create({});
  const BUF = new Uint32Array(1);
  const BUF8 = u8(BUF);
  for (let item of [p, dkLen, m, t, version, type]) {
    BUF[0] = item;
    h.update(BUF8);
  }
  for (let i of [password, salt, key, personalization]) {
    BUF[0] = i.length;
    h.update(BUF8).update(i);
  }
  const H0 = new Uint32Array(18);
  const H0_8 = u8(H0);
  h.digestInto(H0_8);
  const lanes = p;
  const mP = 4 * p * Math.floor(m / (ARGON2_SYNC_POINTS * p));
  const laneLen = Math.floor(mP / p);
  const segmentLen = Math.floor(laneLen / ARGON2_SYNC_POINTS);
  const memUsed = mP * 256;
  if (!isU32(maxmem) || memUsed > maxmem)
    throw new Error("mem should be less than 2**32, got: maxmem=" + maxmem + ", memused=" + memUsed);
  const B = new Uint32Array(memUsed);
  for (let l = 0; l < p; l++) {
    const i = 256 * laneLen * l;
    H0[17] = l;
    H0[16] = 0;
    B.set(Hp(H0, 1024), i);
    H0[16] = 1;
    B.set(Hp(H0, 1024), i + 256);
  }
  let perBlock = () => {
  };
  if (onProgress) {
    const totalBlock = t * ARGON2_SYNC_POINTS * p * segmentLen;
    const callbackPer = Math.max(Math.floor(totalBlock / 1e4), 1);
    let blockCnt = 0;
    perBlock = () => {
      blockCnt++;
      if (onProgress && (!(blockCnt % callbackPer) || blockCnt === totalBlock))
        onProgress(blockCnt / totalBlock);
    };
  }
  clean(BUF, H0);
  return { type, mP, p, t, version, B, laneLen, lanes, segmentLen, dkLen, perBlock, asyncTick };
}
function argon2Output(B, p, laneLen, dkLen) {
  const B_final = new Uint32Array(256);
  for (let l = 0; l < p; l++)
    for (let j = 0; j < 256; j++)
      B_final[j] ^= B[256 * (laneLen * l + laneLen - 1) + j];
  const res = u8(Hp(B_final, dkLen));
  clean(B_final);
  return res;
}
function processBlock(B, address, l, r, s, index, laneLen, segmentLen, lanes, offset, prev, dataIndependent, needXor) {
  if (offset % laneLen)
    prev = offset - 1;
  let randL, randH;
  if (dataIndependent) {
    let i128 = index % 128;
    if (i128 === 0) {
      address[256 + 12]++;
      block(address, 256, 2 * 256, 0, false);
      block(address, 0, 2 * 256, 0, false);
    }
    randL = address[2 * i128];
    randH = address[2 * i128 + 1];
  } else {
    const T = 256 * prev;
    randL = B[T];
    randH = B[T + 1];
  }
  const refLane = r === 0 && s === 0 ? l : randH % lanes;
  const refPos = indexAlpha(r, s, laneLen, segmentLen, index, randL, refLane == l);
  const refBlock = laneLen * refLane + refPos;
  block(B, 256 * prev, 256 * refBlock, offset * 256, needXor);
}
function argon2(type, password, salt, opts) {
  const { mP, p, t, version, B, laneLen, lanes, segmentLen, dkLen, perBlock } = argon2Init(password, salt, type, opts);
  const address = new Uint32Array(3 * 256);
  address[256 + 6] = mP;
  address[256 + 8] = t;
  address[256 + 10] = type;
  for (let r = 0; r < t; r++) {
    const needXor = r !== 0 && version === 19;
    address[256 + 0] = r;
    for (let s = 0; s < ARGON2_SYNC_POINTS; s++) {
      address[256 + 4] = s;
      const dataIndependent = type == AT.Argon2i || type == AT.Argon2id && r === 0 && s < 2;
      for (let l = 0; l < p; l++) {
        address[256 + 2] = l;
        address[256 + 12] = 0;
        let startPos = 0;
        if (r === 0 && s === 0) {
          startPos = 2;
          if (dataIndependent) {
            address[256 + 12]++;
            block(address, 256, 2 * 256, 0, false);
            block(address, 0, 2 * 256, 0, false);
          }
        }
        let offset = l * laneLen + s * segmentLen + startPos;
        let prev = offset % laneLen ? offset - 1 : offset + laneLen - 1;
        for (let index = startPos; index < segmentLen; index++, offset++, prev++) {
          perBlock();
          processBlock(B, address, l, r, s, index, laneLen, segmentLen, lanes, offset, prev, dataIndependent, needXor);
        }
      }
    }
  }
  clean(address);
  return argon2Output(B, p, laneLen, dkLen);
}
var argon2id = (password, salt, opts) => argon2(AT.Argon2id, password, salt, opts);

// node_modules/@noble/hashes/esm/pbkdf2.js
function pbkdf2Init(hash, _password, _salt, _opts) {
  ahash(hash);
  const opts = checkOpts({ dkLen: 32, asyncTick: 10 }, _opts);
  const { c, dkLen, asyncTick } = opts;
  anumber(c);
  anumber(dkLen);
  anumber(asyncTick);
  if (c < 1)
    throw new Error("iterations (c) should be >= 1");
  const password = kdfInputToBytes(_password);
  const salt = kdfInputToBytes(_salt);
  const DK = new Uint8Array(dkLen);
  const PRF = hmac.create(hash, password);
  const PRFSalt = PRF._cloneInto().update(salt);
  return { c, dkLen, asyncTick, DK, PRF, PRFSalt };
}
function pbkdf2Output(PRF, PRFSalt, DK, prfW, u) {
  PRF.destroy();
  PRFSalt.destroy();
  if (prfW)
    prfW.destroy();
  clean(u);
  return DK;
}
function pbkdf2(hash, password, salt, opts) {
  const { c, dkLen, DK, PRF, PRFSalt } = pbkdf2Init(hash, password, salt, opts);
  let prfW;
  const arr = new Uint8Array(4);
  const view2 = createView(arr);
  const u = new Uint8Array(PRF.outputLen);
  for (let ti = 1, pos = 0; pos < dkLen; ti++, pos += PRF.outputLen) {
    const Ti = DK.subarray(pos, pos + PRF.outputLen);
    view2.setInt32(0, ti, false);
    (prfW = PRFSalt._cloneInto(prfW)).update(arr).digestInto(u);
    Ti.set(u.subarray(0, Ti.length));
    for (let ui = 1; ui < c; ui++) {
      PRF._cloneInto(prfW).update(u).digestInto(u);
      for (let i = 0; i < Ti.length; i++)
        Ti[i] ^= u[i];
    }
  }
  return pbkdf2Output(PRF, PRFSalt, DK, prfW, u);
}
async function pbkdf2Async(hash, password, salt, opts) {
  const { c, dkLen, asyncTick, DK, PRF, PRFSalt } = pbkdf2Init(hash, password, salt, opts);
  let prfW;
  const arr = new Uint8Array(4);
  const view2 = createView(arr);
  const u = new Uint8Array(PRF.outputLen);
  for (let ti = 1, pos = 0; pos < dkLen; ti++, pos += PRF.outputLen) {
    const Ti = DK.subarray(pos, pos + PRF.outputLen);
    view2.setInt32(0, ti, false);
    (prfW = PRFSalt._cloneInto(prfW)).update(arr).digestInto(u);
    Ti.set(u.subarray(0, Ti.length));
    await asyncLoop(c - 1, asyncTick, () => {
      PRF._cloneInto(prfW).update(u).digestInto(u);
      for (let i = 0; i < Ti.length; i++)
        Ti[i] ^= u[i];
    });
  }
  return pbkdf2Output(PRF, PRFSalt, DK, prfW, u);
}

// node_modules/@noble/curves/esm/utils.js
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
function abool(title, value) {
  if (typeof value !== "boolean")
    throw new Error(title + " boolean expected, got " + value);
}
function numberToHexUnpadded(num2) {
  const hex2 = num2.toString(16);
  return hex2.length & 1 ? "0" + hex2 : hex2;
}
function hexToNumber(hex2) {
  if (typeof hex2 !== "string")
    throw new Error("hex string expected, got " + typeof hex2);
  return hex2 === "" ? _0n2 : BigInt("0x" + hex2);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  abytes(bytes);
  return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));
}
function numberToBytesBE(n, len) {
  return hexToBytes(n.toString(16).padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function ensureBytes(title, hex2, expectedLength) {
  let res;
  if (typeof hex2 === "string") {
    try {
      res = hexToBytes(hex2);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes(hex2)) {
    res = Uint8Array.from(hex2);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
var isPosBig = (n) => typeof n === "bigint" && _0n2 <= n;
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0; n > _0n2; n >>= _1n2, len += 1)
    ;
  return len;
}
var bitMask = (n) => (_1n2 << BigInt(n)) - _1n2;
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  if (typeof hashLen !== "number" || hashLen < 2)
    throw new Error("hashLen must be a number");
  if (typeof qByteLen !== "number" || qByteLen < 2)
    throw new Error("qByteLen must be a number");
  if (typeof hmacFn !== "function")
    throw new Error("hmacFn must be a function");
  const u8n = (len) => new Uint8Array(len);
  const u8of = (byte) => Uint8Array.of(byte);
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const h = (...b) => hmacFn(k, v, ...b);
  const reseed = (seed = u8n(0)) => {
    k = h(u8of(0), seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(u8of(1), seed);
    v = h();
  };
  const gen2 = () => {
    if (i++ >= 1e3)
      throw new Error("drbg: tried 1000 values");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = void 0;
    while (!(res = pred(gen2())))
      reseed();
    reset();
    return res;
  };
  return genUntil;
}
function _validateObject(object, fields, optFields = {}) {
  if (!object || typeof object !== "object")
    throw new Error("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    const val = object[fieldName];
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));
  Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));
}
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}

// node_modules/@noble/curves/esm/abstract/modular.js
var _0n3 = BigInt(0);
var _1n3 = BigInt(1);
var _2n2 = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _8n = /* @__PURE__ */ BigInt(8);
function mod(a, b) {
  const result = a % b;
  return result >= _0n3 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n3) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n3)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n3)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n3, y = _1n3, u = _1n3, v = _0n3;
  while (a !== _0n3) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd2 = b;
  if (gcd2 !== _1n3)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function sqrt3mod4(Fp2, n) {
  const p1div4 = (Fp2.ORDER + _1n3) / _4n;
  const root = Fp2.pow(n, p1div4);
  if (!Fp2.eql(Fp2.sqr(root), n))
    throw new Error("Cannot find square root");
  return root;
}
function sqrt5mod8(Fp2, n) {
  const p5div8 = (Fp2.ORDER - _5n) / _8n;
  const n2 = Fp2.mul(n, _2n2);
  const v = Fp2.pow(n2, p5div8);
  const nv = Fp2.mul(n, v);
  const i = Fp2.mul(Fp2.mul(nv, _2n2), v);
  const root = Fp2.mul(nv, Fp2.sub(i, Fp2.ONE));
  if (!Fp2.eql(Fp2.sqr(root), n))
    throw new Error("Cannot find square root");
  return root;
}
function tonelliShanks(P2) {
  if (P2 < BigInt(3))
    throw new Error("sqrt is not defined for small field");
  let Q = P2 - _1n3;
  let S = 0;
  while (Q % _2n2 === _0n3) {
    Q /= _2n2;
    S++;
  }
  let Z = _2n2;
  const _Fp = Field(P2);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n3) / _2n2;
  return function tonelliSlow(Fp2, n) {
    if (Fp2.is0(n))
      return n;
    if (FpLegendre(Fp2, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp2.mul(Fp2.ONE, cc);
    let t = Fp2.pow(n, Q);
    let R = Fp2.pow(n, Q1div2);
    while (!Fp2.eql(t, Fp2.ONE)) {
      if (Fp2.is0(t))
        return Fp2.ZERO;
      let i = 1;
      let t_tmp = Fp2.sqr(t);
      while (!Fp2.eql(t_tmp, Fp2.ONE)) {
        i++;
        t_tmp = Fp2.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n3 << BigInt(M - i - 1);
      const b = Fp2.pow(c, exponent);
      M = i;
      c = Fp2.sqr(b);
      t = Fp2.mul(t, c);
      R = Fp2.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P2) {
  if (P2 % _4n === _3n)
    return sqrt3mod4;
  if (P2 % _8n === _5n)
    return sqrt5mod8;
  return tonelliShanks(P2);
}
var isNegativeLE = (num2, modulo) => (mod(num2, modulo) & _1n3) === _1n3;
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    MASK: "bigint",
    BYTES: "number",
    BITS: "number"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  _validateObject(field, opts);
  return field;
}
function FpPow(Fp2, num2, power) {
  if (power < _0n3)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n3)
    return Fp2.ONE;
  if (power === _1n3)
    return num2;
  let p = Fp2.ONE;
  let d = num2;
  while (power > _0n3) {
    if (power & _1n3)
      p = Fp2.mul(p, d);
    d = Fp2.sqr(d);
    power >>= _1n3;
  }
  return p;
}
function FpInvertBatch(Fp2, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp2.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num2, i) => {
    if (Fp2.is0(num2))
      return acc;
    inverted[i] = acc;
    return Fp2.mul(acc, num2);
  }, Fp2.ONE);
  const invertedAcc = Fp2.inv(multipliedAcc);
  nums.reduceRight((acc, num2, i) => {
    if (Fp2.is0(num2))
      return acc;
    inverted[i] = Fp2.mul(acc, inverted[i]);
    return Fp2.mul(acc, num2);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp2, n) {
  const p1mod2 = (Fp2.ORDER - _1n3) / _2n2;
  const powered = Fp2.pow(n, p1mod2);
  const yes = Fp2.eql(powered, Fp2.ONE);
  const zero = Fp2.eql(powered, Fp2.ZERO);
  const no = Fp2.eql(powered, Fp2.neg(Fp2.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber(nBitLength);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
function Field(ORDER, bitLenOrOpts, isLE2 = false, opts = {}) {
  if (ORDER <= _0n3)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
  let _nbitLength = void 0;
  let _sqrt = void 0;
  if (typeof bitLenOrOpts === "object" && bitLenOrOpts != null) {
    if (opts.sqrt || isLE2)
      throw new Error("cannot specify opts in two arguments");
    const _opts = bitLenOrOpts;
    if (_opts.BITS)
      _nbitLength = _opts.BITS;
    if (_opts.sqrt)
      _sqrt = _opts.sqrt;
    if (typeof _opts.isLE === "boolean")
      isLE2 = _opts.isLE;
  } else {
    if (typeof bitLenOrOpts === "number")
      _nbitLength = bitLenOrOpts;
    if (opts.sqrt)
      _sqrt = opts.sqrt;
  }
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER,
    isLE: isLE2,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n3,
    ONE: _1n3,
    create: (num2) => mod(num2, ORDER),
    isValid: (num2) => {
      if (typeof num2 !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num2);
      return _0n3 <= num2 && num2 < ORDER;
    },
    is0: (num2) => num2 === _0n3,
    // is valid and invertible
    isValidNot0: (num2) => !f.is0(num2) && f.isValid(num2),
    isOdd: (num2) => (num2 & _1n3) === _1n3,
    neg: (num2) => mod(-num2, ORDER),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num2) => mod(num2 * num2, ORDER),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
    pow: (num2, power) => FpPow(f, num2, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
    // Same as above, but doesn't normalize
    sqrN: (num2) => num2 * num2,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num2) => invert(num2, ORDER),
    sqrt: _sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER);
      return sqrtP(f, n);
    }),
    toBytes: (num2) => isLE2 ? numberToBytesLE(num2, BYTES) : numberToBytesBE(num2, BYTES),
    fromBytes: (bytes) => {
      if (bytes.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
      return isLE2 ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    },
    // TODO: we don't need it here, move out to separate fn
    invertBatch: (lst) => FpInvertBatch(f, lst),
    // We can't move this out because Fp6, Fp12 implement it
    // and it's unclear what to return in there.
    cmov: (a, b, c) => c ? b : a
  });
  return Object.freeze(f);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE2 = false) {
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num2 = isLE2 ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num2, fieldOrder - _1n3) + _1n3;
  return isLE2 ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

// node_modules/@noble/curves/esm/abstract/curve.js
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
function negateCt(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, property, points) {
  const getz = property === "pz" ? (p) => p.pz : (p) => p.ez;
  const toInv = FpInvertBatch(c.Fp, points.map(getz));
  const affined = points.map((p, i) => p.toAffine(toInv[i]));
  return affined.map(c.fromAffine);
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n4;
  }
  const offsetStart = window * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
function validateMSMPoints(points, c) {
  if (!Array.isArray(points))
    throw new Error("array expected");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!field.isValid(s))
      throw new Error("invalid scalar at index " + i);
  });
}
var pointPrecomputes = /* @__PURE__ */ new WeakMap();
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P2) {
  return pointWindowSizes.get(P2) || 1;
}
function assert0(n) {
  if (n !== _0n4)
    throw new Error("invalid wNAF");
}
function wNAF(c, bits) {
  return {
    constTimeNegate: negateCt,
    hasPrecomputes(elm) {
      return getW(elm) !== 1;
    },
    // non-const time multiplication ladder
    unsafeLadder(elm, n, p = c.ZERO) {
      let d = elm;
      while (n > _0n4) {
        if (n & _1n4)
          p = p.add(d);
        d = d.double();
        n >>= _1n4;
      }
      return p;
    },
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param elm Point instance
     * @param W window size
     * @returns precomputed point tables flattened to a single array
     */
    precomputeWindow(elm, W) {
      const { windows, windowSize } = calcWOpts(W, bits);
      const points = [];
      let p = elm;
      let base = p;
      for (let window = 0; window < windows; window++) {
        base = p;
        points.push(base);
        for (let i = 1; i < windowSize; i++) {
          base = base.add(p);
          points.push(base);
        }
        p = base.double();
      }
      return points;
    },
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @returns real and fake (for const-time) points
     */
    wNAF(W, precomputes, n) {
      let p = c.ZERO;
      let f = c.BASE;
      const wo = calcWOpts(W, bits);
      for (let window = 0; window < wo.windows; window++) {
        const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          f = f.add(negateCt(isNegF, precomputes[offsetF]));
        } else {
          p = p.add(negateCt(isNeg, precomputes[offset]));
        }
      }
      assert0(n);
      return { p, f };
    },
    /**
     * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @param acc accumulator point to add result of multiplication
     * @returns point
     */
    wNAFUnsafe(W, precomputes, n, acc = c.ZERO) {
      const wo = calcWOpts(W, bits);
      for (let window = 0; window < wo.windows; window++) {
        if (n === _0n4)
          break;
        const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          continue;
        } else {
          const item = precomputes[offset];
          acc = acc.add(isNeg ? item.negate() : item);
        }
      }
      assert0(n);
      return acc;
    },
    getPrecomputes(W, P2, transform) {
      let comp = pointPrecomputes.get(P2);
      if (!comp) {
        comp = this.precomputeWindow(P2, W);
        if (W !== 1) {
          if (typeof transform === "function")
            comp = transform(comp);
          pointPrecomputes.set(P2, comp);
        }
      }
      return comp;
    },
    wNAFCached(P2, n, transform) {
      const W = getW(P2);
      return this.wNAF(W, this.getPrecomputes(W, P2, transform), n);
    },
    wNAFCachedUnsafe(P2, n, transform, prev) {
      const W = getW(P2);
      if (W === 1)
        return this.unsafeLadder(P2, n, prev);
      return this.wNAFUnsafe(W, this.getPrecomputes(W, P2, transform), n, prev);
    },
    // We calculate precomputes for elliptic curve point multiplication
    // using windowed method. This specifies window size and
    // stores precomputed values. Usually only base point would be precomputed.
    setWindowSize(P2, W) {
      validateW(W, bits);
      pointWindowSizes.set(P2, W);
      pointPrecomputes.delete(P2);
    }
  };
}
function mulEndoUnsafe(c, point, k1, k2) {
  let acc = point;
  let p1 = c.ZERO;
  let p2 = c.ZERO;
  while (k1 > _0n4 || k2 > _0n4) {
    if (k1 & _1n4)
      p1 = p1.add(acc);
    if (k2 & _1n4)
      p2 = p2.add(acc);
    acc = acc.double();
    k1 >>= _1n4;
    k2 >>= _1n4;
  }
  return { p1, p2 };
}
function pippenger(c, fieldN, points, scalars) {
  validateMSMPoints(points, c);
  validateMSMScalars(scalars, fieldN);
  const plength = points.length;
  const slength = scalars.length;
  if (plength !== slength)
    throw new Error("arrays of points and scalars must have equal length");
  const zero = c.ZERO;
  const wbits = bitLen(BigInt(plength));
  let windowSize = 1;
  if (wbits > 12)
    windowSize = wbits - 3;
  else if (wbits > 4)
    windowSize = wbits - 2;
  else if (wbits > 0)
    windowSize = 2;
  const MASK = bitMask(windowSize);
  const buckets = new Array(Number(MASK) + 1).fill(zero);
  const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
  let sum = zero;
  for (let i = lastBits; i >= 0; i -= windowSize) {
    buckets.fill(zero);
    for (let j = 0; j < slength; j++) {
      const scalar = scalars[j];
      const wbits2 = Number(scalar >> BigInt(i) & MASK);
      buckets[wbits2] = buckets[wbits2].add(points[j]);
    }
    let resI = zero;
    for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
      sumI = sumI.add(buckets[j]);
      resI = resI.add(sumI);
    }
    sum = sum.add(resI);
    if (i !== 0)
      for (let j = 0; j < windowSize; j++)
        sum = sum.double();
  }
  return sum;
}
function createField(order, field) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order);
  }
}
function _createCurveFields(type, CURVE, curveOpts = {}) {
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n4))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp2 = createField(CURVE.p, curveOpts.Fp);
  const Fn = createField(CURVE.n, curveOpts.Fn);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp2.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  return { Fp: Fp2, Fn };
}

// node_modules/@noble/curves/esm/abstract/weierstrass.js
function validateSigVerOpts(opts) {
  if (opts.lowS !== void 0)
    abool("lowS", opts.lowS);
  if (opts.prehash !== void 0)
    abool("prehash", opts.prehash);
}
var DERErr = class extends Error {
  constructor(m = "") {
    super(m);
  }
};
var DER = {
  // asn.1 DER encoding utils
  Err: DERErr,
  // Basic building block is TLV (Tag-Length-Value)
  _tlv: {
    encode: (tag, data) => {
      const { Err: E } = DER;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length & 1)
        throw new E("tlv.encode: unpadded data");
      const dataLen = data.length / 2;
      const len = numberToHexUnpadded(dataLen);
      if (len.length / 2 & 128)
        throw new E("tlv.encode: long form length too big");
      const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
      const t = numberToHexUnpadded(tag);
      return t + lenLen + len + data;
    },
    // v - value, l - left bytes (unparsed)
    decode(tag, data) {
      const { Err: E } = DER;
      let pos = 0;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length < 2 || data[pos++] !== tag)
        throw new E("tlv.decode: wrong tlv");
      const first = data[pos++];
      const isLong = !!(first & 128);
      let length = 0;
      if (!isLong)
        length = first;
      else {
        const lenLen = first & 127;
        if (!lenLen)
          throw new E("tlv.decode(long): indefinite length not supported");
        if (lenLen > 4)
          throw new E("tlv.decode(long): byte length is too big");
        const lengthBytes = data.subarray(pos, pos + lenLen);
        if (lengthBytes.length !== lenLen)
          throw new E("tlv.decode: length bytes not complete");
        if (lengthBytes[0] === 0)
          throw new E("tlv.decode(long): zero leftmost byte");
        for (const b of lengthBytes)
          length = length << 8 | b;
        pos += lenLen;
        if (length < 128)
          throw new E("tlv.decode(long): not minimal encoding");
      }
      const v = data.subarray(pos, pos + length);
      if (v.length !== length)
        throw new E("tlv.decode: wrong value length");
      return { v, l: data.subarray(pos + length) };
    }
  },
  // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
  // since we always use positive integers here. It must always be empty:
  // - add zero byte if exists
  // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
  _int: {
    encode(num2) {
      const { Err: E } = DER;
      if (num2 < _0n5)
        throw new E("integer: negative integers are not allowed");
      let hex2 = numberToHexUnpadded(num2);
      if (Number.parseInt(hex2[0], 16) & 8)
        hex2 = "00" + hex2;
      if (hex2.length & 1)
        throw new E("unexpected DER parsing assertion: unpadded hex");
      return hex2;
    },
    decode(data) {
      const { Err: E } = DER;
      if (data[0] & 128)
        throw new E("invalid signature integer: negative");
      if (data[0] === 0 && !(data[1] & 128))
        throw new E("invalid signature integer: unnecessary leading zero");
      return bytesToNumberBE(data);
    }
  },
  toSig(hex2) {
    const { Err: E, _int: int, _tlv: tlv } = DER;
    const data = ensureBytes("signature", hex2);
    const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
    if (seqLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
    const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
    if (sLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    return { r: int.decode(rBytes), s: int.decode(sBytes) };
  },
  hexFromSig(sig) {
    const { _tlv: tlv, _int: int } = DER;
    const rs = tlv.encode(2, int.encode(sig.r));
    const ss = tlv.encode(2, int.encode(sig.s));
    const seq = rs + ss;
    return tlv.encode(48, seq);
  }
};
var _0n5 = BigInt(0);
var _1n5 = BigInt(1);
var _2n3 = BigInt(2);
var _3n2 = BigInt(3);
var _4n2 = BigInt(4);
function _legacyHelperEquat(Fp2, a, b) {
  function weierstrassEquation(x) {
    const x2 = Fp2.sqr(x);
    const x3 = Fp2.mul(x2, x);
    return Fp2.add(Fp2.add(x3, Fp2.mul(x, a)), b);
  }
  return weierstrassEquation;
}
function _legacyHelperNormPriv(Fn, allowedPrivateKeyLengths, wrapPrivateKey) {
  const { BYTES: expected } = Fn;
  function normPrivateKeyToScalar(key) {
    let num2;
    if (typeof key === "bigint") {
      num2 = key;
    } else {
      let bytes = ensureBytes("private key", key);
      if (allowedPrivateKeyLengths) {
        if (!allowedPrivateKeyLengths.includes(bytes.length * 2))
          throw new Error("invalid private key");
        const padded = new Uint8Array(expected);
        padded.set(bytes, padded.length - bytes.length);
        bytes = padded;
      }
      try {
        num2 = Fn.fromBytes(bytes);
      } catch (error) {
        throw new Error(`invalid private key: expected ui8a of size ${expected}, got ${typeof key}`);
      }
    }
    if (wrapPrivateKey)
      num2 = Fn.create(num2);
    if (!Fn.isValidNot0(num2))
      throw new Error("invalid private key: out of range [1..N-1]");
    return num2;
  }
  return normPrivateKeyToScalar;
}
function weierstrassN(CURVE, curveOpts = {}) {
  const { Fp: Fp2, Fn } = _createCurveFields("weierstrass", CURVE, curveOpts);
  const { h: cofactor, n: CURVE_ORDER2 } = CURVE;
  _validateObject(curveOpts, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object",
    wrapPrivateKey: "boolean"
  });
  const { endo } = curveOpts;
  if (endo) {
    if (!Fp2.is0(CURVE.a) || typeof endo.beta !== "bigint" || typeof endo.splitScalar !== "function") {
      throw new Error('invalid endo: expected "beta": bigint and "splitScalar": function');
    }
  }
  function assertCompressionIsSupported() {
    if (!Fp2.isOdd)
      throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function pointToBytes2(_c, point, isCompressed) {
    const { x, y } = point.toAffine();
    const bx = Fp2.toBytes(x);
    abool("isCompressed", isCompressed);
    if (isCompressed) {
      assertCompressionIsSupported();
      const hasEvenY = !Fp2.isOdd(y);
      return concatBytes(pprefix(hasEvenY), bx);
    } else {
      return concatBytes(Uint8Array.of(4), bx, Fp2.toBytes(y));
    }
  }
  function pointFromBytes(bytes) {
    abytes(bytes);
    const L = Fp2.BYTES;
    const LC = L + 1;
    const LU = 2 * L + 1;
    const length = bytes.length;
    const head = bytes[0];
    const tail = bytes.subarray(1);
    if (length === LC && (head === 2 || head === 3)) {
      const x = Fp2.fromBytes(tail);
      if (!Fp2.isValid(x))
        throw new Error("bad point: is not on curve, wrong x");
      const y2 = weierstrassEquation(x);
      let y;
      try {
        y = Fp2.sqrt(y2);
      } catch (sqrtError) {
        const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + err);
      }
      assertCompressionIsSupported();
      const isYOdd = Fp2.isOdd(y);
      const isHeadOdd = (head & 1) === 1;
      if (isHeadOdd !== isYOdd)
        y = Fp2.neg(y);
      return { x, y };
    } else if (length === LU && head === 4) {
      const x = Fp2.fromBytes(tail.subarray(L * 0, L * 1));
      const y = Fp2.fromBytes(tail.subarray(L * 1, L * 2));
      if (!isValidXY(x, y))
        throw new Error("bad point: is not on curve");
      return { x, y };
    } else {
      throw new Error(`bad point: got length ${length}, expected compressed=${LC} or uncompressed=${LU}`);
    }
  }
  const toBytes2 = curveOpts.toBytes || pointToBytes2;
  const fromBytes = curveOpts.fromBytes || pointFromBytes;
  const weierstrassEquation = _legacyHelperEquat(Fp2, CURVE.a, CURVE.b);
  function isValidXY(x, y) {
    const left = Fp2.sqr(y);
    const right = weierstrassEquation(x);
    return Fp2.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp2.mul(Fp2.pow(CURVE.a, _3n2), _4n2);
  const _27b2 = Fp2.mul(Fp2.sqr(CURVE.b), BigInt(27));
  if (Fp2.is0(Fp2.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function acoord(title, n, banZero = false) {
    if (!Fp2.isValid(n) || banZero && Fp2.is0(n))
      throw new Error(`bad point coordinate ${title}`);
    return n;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point4))
      throw new Error("ProjectivePoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { px: x, py: y, pz: z } = p;
    if (Fp2.eql(z, Fp2.ONE))
      return { x, y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp2.ONE : Fp2.inv(z);
    const ax = Fp2.mul(x, iz);
    const ay = Fp2.mul(y, iz);
    const zz = Fp2.mul(z, iz);
    if (is0)
      return { x: Fp2.ZERO, y: Fp2.ZERO };
    if (!Fp2.eql(zz, Fp2.ONE))
      throw new Error("invZ was invalid");
    return { x: ax, y: ay };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (curveOpts.allowInfinityPoint && !Fp2.is0(p.py))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp2.isValid(x) || !Fp2.isValid(y))
      throw new Error("bad point: x or y not field elements");
    if (!isValidXY(x, y))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
    k2p = new Point4(Fp2.mul(k2p.px, endoBeta), k2p.py, k2p.pz);
    k1p = negateCt(k1neg, k1p);
    k2p = negateCt(k2neg, k2p);
    return k1p.add(k2p);
  }
  class Point4 {
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    constructor(px, py, pz) {
      this.px = acoord("x", px);
      this.py = acoord("y", py, true);
      this.pz = acoord("z", pz);
      Object.freeze(this);
    }
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp2.isValid(x) || !Fp2.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point4)
        throw new Error("projective point not allowed");
      if (Fp2.is0(x) && Fp2.is0(y))
        return Point4.ZERO;
      return new Point4(x, y, Fp2.ONE);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    static normalizeZ(points) {
      return normalizeZ(Point4, "pz", points);
    }
    static fromBytes(bytes) {
      abytes(bytes);
      return Point4.fromHex(bytes);
    }
    /** Converts hash string or Uint8Array to Point. */
    static fromHex(hex2) {
      const P2 = Point4.fromAffine(fromBytes(ensureBytes("pointHex", hex2)));
      P2.assertValidity();
      return P2;
    }
    /** Multiplies generator point by privateKey. */
    static fromPrivateKey(privateKey) {
      const normPrivateKeyToScalar = _legacyHelperNormPriv(Fn, curveOpts.allowedPrivateKeyLengths, curveOpts.wrapPrivateKey);
      return Point4.BASE.multiply(normPrivateKeyToScalar(privateKey));
    }
    /** Multiscalar Multiplication */
    static msm(points, scalars) {
      return pippenger(Point4, Fn, points, scalars);
    }
    /**
     *
     * @param windowSize
     * @param isLazy true will defer table computation until the first multiplication
     * @returns
     */
    precompute(windowSize = 8, isLazy = true) {
      wnaf.setWindowSize(this, windowSize);
      if (!isLazy)
        this.multiply(_3n2);
      return this;
    }
    /** "Private method", don't use it directly */
    _setWindowSize(windowSize) {
      this.precompute(windowSize);
    }
    // TODO: return `this`
    /** A point on curve is valid if it conforms to equation. */
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (!Fp2.isOdd)
        throw new Error("Field doesn't support isOdd");
      return !Fp2.isOdd(y);
    }
    /** Compare one point to another. */
    equals(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      const U1 = Fp2.eql(Fp2.mul(X1, Z2), Fp2.mul(X2, Z1));
      const U2 = Fp2.eql(Fp2.mul(Y1, Z2), Fp2.mul(Y2, Z1));
      return U1 && U2;
    }
    /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
    negate() {
      return new Point4(this.px, Fp2.neg(this.py), this.pz);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a, b } = CURVE;
      const b3 = Fp2.mul(b, _3n2);
      const { px: X1, py: Y1, pz: Z1 } = this;
      let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
      let t0 = Fp2.mul(X1, X1);
      let t1 = Fp2.mul(Y1, Y1);
      let t2 = Fp2.mul(Z1, Z1);
      let t3 = Fp2.mul(X1, Y1);
      t3 = Fp2.add(t3, t3);
      Z3 = Fp2.mul(X1, Z1);
      Z3 = Fp2.add(Z3, Z3);
      X3 = Fp2.mul(a, Z3);
      Y3 = Fp2.mul(b3, t2);
      Y3 = Fp2.add(X3, Y3);
      X3 = Fp2.sub(t1, Y3);
      Y3 = Fp2.add(t1, Y3);
      Y3 = Fp2.mul(X3, Y3);
      X3 = Fp2.mul(t3, X3);
      Z3 = Fp2.mul(b3, Z3);
      t2 = Fp2.mul(a, t2);
      t3 = Fp2.sub(t0, t2);
      t3 = Fp2.mul(a, t3);
      t3 = Fp2.add(t3, Z3);
      Z3 = Fp2.add(t0, t0);
      t0 = Fp2.add(Z3, t0);
      t0 = Fp2.add(t0, t2);
      t0 = Fp2.mul(t0, t3);
      Y3 = Fp2.add(Y3, t0);
      t2 = Fp2.mul(Y1, Z1);
      t2 = Fp2.add(t2, t2);
      t0 = Fp2.mul(t2, t3);
      X3 = Fp2.sub(X3, t0);
      Z3 = Fp2.mul(t2, t1);
      Z3 = Fp2.add(Z3, Z3);
      Z3 = Fp2.add(Z3, Z3);
      return new Point4(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      aprjpoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
      const a = CURVE.a;
      const b3 = Fp2.mul(CURVE.b, _3n2);
      let t0 = Fp2.mul(X1, X2);
      let t1 = Fp2.mul(Y1, Y2);
      let t2 = Fp2.mul(Z1, Z2);
      let t3 = Fp2.add(X1, Y1);
      let t4 = Fp2.add(X2, Y2);
      t3 = Fp2.mul(t3, t4);
      t4 = Fp2.add(t0, t1);
      t3 = Fp2.sub(t3, t4);
      t4 = Fp2.add(X1, Z1);
      let t5 = Fp2.add(X2, Z2);
      t4 = Fp2.mul(t4, t5);
      t5 = Fp2.add(t0, t2);
      t4 = Fp2.sub(t4, t5);
      t5 = Fp2.add(Y1, Z1);
      X3 = Fp2.add(Y2, Z2);
      t5 = Fp2.mul(t5, X3);
      X3 = Fp2.add(t1, t2);
      t5 = Fp2.sub(t5, X3);
      Z3 = Fp2.mul(a, t4);
      X3 = Fp2.mul(b3, t2);
      Z3 = Fp2.add(X3, Z3);
      X3 = Fp2.sub(t1, Z3);
      Z3 = Fp2.add(t1, Z3);
      Y3 = Fp2.mul(X3, Z3);
      t1 = Fp2.add(t0, t0);
      t1 = Fp2.add(t1, t0);
      t2 = Fp2.mul(a, t2);
      t4 = Fp2.mul(b3, t4);
      t1 = Fp2.add(t1, t2);
      t2 = Fp2.sub(t0, t2);
      t2 = Fp2.mul(a, t2);
      t4 = Fp2.add(t4, t2);
      t0 = Fp2.mul(t1, t4);
      Y3 = Fp2.add(Y3, t0);
      t0 = Fp2.mul(t5, t4);
      X3 = Fp2.mul(t3, X3);
      X3 = Fp2.sub(X3, t0);
      t0 = Fp2.mul(t3, t1);
      Z3 = Fp2.mul(t5, Z3);
      Z3 = Fp2.add(Z3, t0);
      return new Point4(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point4.ZERO);
    }
    /**
     * Constant time multiplication.
     * Uses wNAF method. Windowed method may be 10% faster,
     * but takes 2x longer to generate and consumes 2x memory.
     * Uses precomputes when available.
     * Uses endomorphism for Koblitz curves.
     * @param scalar by which the point would be multiplied
     * @returns New point
     */
    multiply(scalar) {
      const { endo: endo2 } = curveOpts;
      if (!Fn.isValidNot0(scalar))
        throw new Error("invalid scalar: out of range");
      let point, fake;
      const mul3 = (n) => wnaf.wNAFCached(this, n, Point4.normalizeZ);
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = endo2.splitScalar(scalar);
        const { p: k1p, f: k1f } = mul3(k1);
        const { p: k2p, f: k2f } = mul3(k2);
        fake = k1f.add(k2f);
        point = finishEndo(endo2.beta, k1p, k2p, k1neg, k2neg);
      } else {
        const { p, f } = mul3(scalar);
        point = p;
        fake = f;
      }
      return Point4.normalizeZ([point, fake])[0];
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed private key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(sc) {
      const { endo: endo2 } = curveOpts;
      const p = this;
      if (!Fn.isValid(sc))
        throw new Error("invalid scalar: out of range");
      if (sc === _0n5 || p.is0())
        return Point4.ZERO;
      if (sc === _1n5)
        return p;
      if (wnaf.hasPrecomputes(this))
        return this.multiply(sc);
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = endo2.splitScalar(sc);
        const { p1, p2 } = mulEndoUnsafe(Point4, p, k1, k2);
        return finishEndo(endo2.beta, p1, p2, k1neg, k2neg);
      } else {
        return wnaf.wNAFCachedUnsafe(p, sc);
      }
    }
    multiplyAndAddUnsafe(Q, a, b) {
      const sum = this.multiplyUnsafe(a).add(Q.multiplyUnsafe(b));
      return sum.is0() ? void 0 : sum;
    }
    /**
     * Converts Projective point to affine (x, y) coordinates.
     * @param invertedZ Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
     */
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    /**
     * Checks whether Point is free of torsion elements (is in prime subgroup).
     * Always torsion-free for cofactor=1 curves.
     */
    isTorsionFree() {
      const { isTorsionFree } = curveOpts;
      if (cofactor === _1n5)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point4, this);
      return wnaf.wNAFCachedUnsafe(this, CURVE_ORDER2).is0();
    }
    clearCofactor() {
      const { clearCofactor } = curveOpts;
      if (cofactor === _1n5)
        return this;
      if (clearCofactor)
        return clearCofactor(Point4, this);
      return this.multiplyUnsafe(cofactor);
    }
    toBytes(isCompressed = true) {
      abool("isCompressed", isCompressed);
      this.assertValidity();
      return toBytes2(Point4, this, isCompressed);
    }
    /** @deprecated use `toBytes` */
    toRawBytes(isCompressed = true) {
      return this.toBytes(isCompressed);
    }
    toHex(isCompressed = true) {
      return bytesToHex(this.toBytes(isCompressed));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  Point4.BASE = new Point4(CURVE.Gx, CURVE.Gy, Fp2.ONE);
  Point4.ZERO = new Point4(Fp2.ZERO, Fp2.ONE, Fp2.ZERO);
  Point4.Fp = Fp2;
  Point4.Fn = Fn;
  const bits = Fn.BITS;
  const wnaf = wNAF(Point4, curveOpts.endo ? Math.ceil(bits / 2) : bits);
  return Point4;
}
function pprefix(hasEvenY) {
  return Uint8Array.of(hasEvenY ? 2 : 3);
}
function ecdsa(Point4, ecdsaOpts, curveOpts = {}) {
  _validateObject(ecdsaOpts, { hash: "function" }, {
    hmac: "function",
    lowS: "boolean",
    randomBytes: "function",
    bits2int: "function",
    bits2int_modN: "function"
  });
  const randomBytes_ = ecdsaOpts.randomBytes || randomBytes;
  const hmac_ = ecdsaOpts.hmac || ((key, ...msgs) => hmac(ecdsaOpts.hash, key, concatBytes(...msgs)));
  const { Fp: Fp2, Fn } = Point4;
  const { ORDER: CURVE_ORDER2, BITS: fnBits } = Fn;
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER2 >> _1n5;
    return number > HALF;
  }
  function normalizeS(s) {
    return isBiggerThanHalfOrder(s) ? Fn.neg(s) : s;
  }
  function aValidRS(title, num2) {
    if (!Fn.isValidNot0(num2))
      throw new Error(`invalid signature ${title}: out of range 1..CURVE.n`);
  }
  class Signature {
    constructor(r, s, recovery) {
      aValidRS("r", r);
      aValidRS("s", s);
      this.r = r;
      this.s = s;
      if (recovery != null)
        this.recovery = recovery;
      Object.freeze(this);
    }
    // pair (bytes of r, bytes of s)
    static fromCompact(hex2) {
      const L = Fn.BYTES;
      const b = ensureBytes("compactSignature", hex2, L * 2);
      return new Signature(Fn.fromBytes(b.subarray(0, L)), Fn.fromBytes(b.subarray(L, L * 2)));
    }
    // DER encoded ECDSA signature
    // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
    static fromDER(hex2) {
      const { r, s } = DER.toSig(ensureBytes("DER", hex2));
      return new Signature(r, s);
    }
    /**
     * @todo remove
     * @deprecated
     */
    assertValidity() {
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    // ProjPointType<bigint>
    recoverPublicKey(msgHash) {
      const FIELD_ORDER = Fp2.ORDER;
      const { r, s, recovery: rec } = this;
      if (rec == null || ![0, 1, 2, 3].includes(rec))
        throw new Error("recovery id invalid");
      const hasCofactor = CURVE_ORDER2 * _2n3 < FIELD_ORDER;
      if (hasCofactor && rec > 1)
        throw new Error("recovery id is ambiguous for h>1 curve");
      const radj = rec === 2 || rec === 3 ? r + CURVE_ORDER2 : r;
      if (!Fp2.isValid(radj))
        throw new Error("recovery id 2 or 3 invalid");
      const x = Fp2.toBytes(radj);
      const R = Point4.fromHex(concatBytes(pprefix((rec & 1) === 0), x));
      const ir = Fn.inv(radj);
      const h = bits2int_modN(ensureBytes("msgHash", msgHash));
      const u1 = Fn.create(-h * ir);
      const u2 = Fn.create(s * ir);
      const Q = Point4.BASE.multiplyUnsafe(u1).add(R.multiplyUnsafe(u2));
      if (Q.is0())
        throw new Error("point at infinify");
      Q.assertValidity();
      return Q;
    }
    // Signatures should be low-s, to prevent malleability.
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    normalizeS() {
      return this.hasHighS() ? new Signature(this.r, Fn.neg(this.s), this.recovery) : this;
    }
    toBytes(format) {
      if (format === "compact")
        return concatBytes(Fn.toBytes(this.r), Fn.toBytes(this.s));
      if (format === "der")
        return hexToBytes(DER.hexFromSig(this));
      throw new Error("invalid format");
    }
    // DER-encoded
    toDERRawBytes() {
      return this.toBytes("der");
    }
    toDERHex() {
      return bytesToHex(this.toBytes("der"));
    }
    // padded bytes of r, then padded bytes of s
    toCompactRawBytes() {
      return this.toBytes("compact");
    }
    toCompactHex() {
      return bytesToHex(this.toBytes("compact"));
    }
  }
  const normPrivateKeyToScalar = _legacyHelperNormPriv(Fn, curveOpts.allowedPrivateKeyLengths, curveOpts.wrapPrivateKey);
  const utils4 = {
    isValidPrivateKey(privateKey) {
      try {
        normPrivateKeyToScalar(privateKey);
        return true;
      } catch (error) {
        return false;
      }
    },
    normPrivateKeyToScalar,
    /**
     * Produces cryptographically secure private key from random of size
     * (groupLen + ceil(groupLen / 2)) with modulo bias being negligible.
     */
    randomPrivateKey: () => {
      const n = CURVE_ORDER2;
      return mapHashToField(randomBytes_(getMinHashLength(n)), n);
    },
    precompute(windowSize = 8, point = Point4.BASE) {
      return point.precompute(windowSize, false);
    }
  };
  function getPublicKey(privateKey, isCompressed = true) {
    return Point4.fromPrivateKey(privateKey).toBytes(isCompressed);
  }
  function isProbPub(item) {
    if (typeof item === "bigint")
      return false;
    if (item instanceof Point4)
      return true;
    const arr = ensureBytes("key", item);
    const length = arr.length;
    const L = Fp2.BYTES;
    const LC = L + 1;
    const LU = 2 * L + 1;
    if (curveOpts.allowedPrivateKeyLengths || Fn.BYTES === LC) {
      return void 0;
    } else {
      return length === LC || length === LU;
    }
  }
  function getSharedSecret(privateA, publicB, isCompressed = true) {
    if (isProbPub(privateA) === true)
      throw new Error("first arg must be private key");
    if (isProbPub(publicB) === false)
      throw new Error("second arg must be public key");
    const b = Point4.fromHex(publicB);
    return b.multiply(normPrivateKeyToScalar(privateA)).toBytes(isCompressed);
  }
  const bits2int = ecdsaOpts.bits2int || function(bytes) {
    if (bytes.length > 8192)
      throw new Error("input is too large");
    const num2 = bytesToNumberBE(bytes);
    const delta = bytes.length * 8 - fnBits;
    return delta > 0 ? num2 >> BigInt(delta) : num2;
  };
  const bits2int_modN = ecdsaOpts.bits2int_modN || function(bytes) {
    return Fn.create(bits2int(bytes));
  };
  const ORDER_MASK = bitMask(fnBits);
  function int2octets(num2) {
    aInRange("num < 2^" + fnBits, num2, _0n5, ORDER_MASK);
    return Fn.toBytes(num2);
  }
  function prepSig(msgHash, privateKey, opts = defaultSigOpts) {
    if (["recovered", "canonical"].some((k) => k in opts))
      throw new Error("sign() legacy options not supported");
    const { hash } = ecdsaOpts;
    let { lowS, prehash, extraEntropy: ent } = opts;
    if (lowS == null)
      lowS = true;
    msgHash = ensureBytes("msgHash", msgHash);
    validateSigVerOpts(opts);
    if (prehash)
      msgHash = ensureBytes("prehashed msgHash", hash(msgHash));
    const h1int = bits2int_modN(msgHash);
    const d = normPrivateKeyToScalar(privateKey);
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (ent != null && ent !== false) {
      const e = ent === true ? randomBytes_(Fp2.BYTES) : ent;
      seedArgs.push(ensureBytes("extraEntropy", e));
    }
    const seed = concatBytes(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!Fn.isValidNot0(k))
        return;
      const ik = Fn.inv(k);
      const q = Point4.BASE.multiply(k).toAffine();
      const r = Fn.create(q.x);
      if (r === _0n5)
        return;
      const s = Fn.create(ik * Fn.create(m + r * d));
      if (s === _0n5)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n5);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = normalizeS(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, recovery);
    }
    return { seed, k2sig };
  }
  const defaultSigOpts = { lowS: ecdsaOpts.lowS, prehash: false };
  const defaultVerOpts = { lowS: ecdsaOpts.lowS, prehash: false };
  function sign(msgHash, privKey, opts = defaultSigOpts) {
    const { seed, k2sig } = prepSig(msgHash, privKey, opts);
    const drbg = createHmacDrbg(ecdsaOpts.hash.outputLen, Fn.BYTES, hmac_);
    return drbg(seed, k2sig);
  }
  Point4.BASE.precompute(8);
  function verify(signature, msgHash, publicKey, opts = defaultVerOpts) {
    const sg = signature;
    msgHash = ensureBytes("msgHash", msgHash);
    publicKey = ensureBytes("publicKey", publicKey);
    validateSigVerOpts(opts);
    const { lowS, prehash, format } = opts;
    if ("strict" in opts)
      throw new Error("options.strict was renamed to lowS");
    if (format !== void 0 && !["compact", "der", "js"].includes(format))
      throw new Error('format must be "compact", "der" or "js"');
    const isHex = typeof sg === "string" || isBytes(sg);
    const isObj = !isHex && !format && typeof sg === "object" && sg !== null && typeof sg.r === "bigint" && typeof sg.s === "bigint";
    if (!isHex && !isObj)
      throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");
    let _sig = void 0;
    let P2;
    try {
      if (isObj) {
        if (format === void 0 || format === "js") {
          _sig = new Signature(sg.r, sg.s);
        } else {
          throw new Error("invalid format");
        }
      }
      if (isHex) {
        try {
          if (format !== "compact")
            _sig = Signature.fromDER(sg);
        } catch (derError) {
          if (!(derError instanceof DER.Err))
            throw derError;
        }
        if (!_sig && format !== "der")
          _sig = Signature.fromCompact(sg);
      }
      P2 = Point4.fromHex(publicKey);
    } catch (error) {
      return false;
    }
    if (!_sig)
      return false;
    if (lowS && _sig.hasHighS())
      return false;
    if (prehash)
      msgHash = ecdsaOpts.hash(msgHash);
    const { r, s } = _sig;
    const h = bits2int_modN(msgHash);
    const is = Fn.inv(s);
    const u1 = Fn.create(h * is);
    const u2 = Fn.create(r * is);
    const R = Point4.BASE.multiplyUnsafe(u1).add(P2.multiplyUnsafe(u2));
    if (R.is0())
      return false;
    const v = Fn.create(R.x);
    return v === r;
  }
  return Object.freeze({
    getPublicKey,
    getSharedSecret,
    sign,
    verify,
    utils: utils4,
    Point: Point4,
    Signature
  });
}
function _weierstrass_legacy_opts_to_new(c) {
  const CURVE = {
    a: c.a,
    b: c.b,
    p: c.Fp.ORDER,
    n: c.n,
    h: c.h,
    Gx: c.Gx,
    Gy: c.Gy
  };
  const Fp2 = c.Fp;
  const Fn = Field(CURVE.n, c.nBitLength);
  const curveOpts = {
    Fp: Fp2,
    Fn,
    allowedPrivateKeyLengths: c.allowedPrivateKeyLengths,
    allowInfinityPoint: c.allowInfinityPoint,
    endo: c.endo,
    wrapPrivateKey: c.wrapPrivateKey,
    isTorsionFree: c.isTorsionFree,
    clearCofactor: c.clearCofactor,
    fromBytes: c.fromBytes,
    toBytes: c.toBytes
  };
  return { CURVE, curveOpts };
}
function _ecdsa_legacy_opts_to_new(c) {
  const { CURVE, curveOpts } = _weierstrass_legacy_opts_to_new(c);
  const ecdsaOpts = {
    hash: c.hash,
    hmac: c.hmac,
    randomBytes: c.randomBytes,
    lowS: c.lowS,
    bits2int: c.bits2int,
    bits2int_modN: c.bits2int_modN
  };
  return { CURVE, curveOpts, ecdsaOpts };
}
function _ecdsa_new_output_to_legacy(c, ecdsa2) {
  return Object.assign({}, ecdsa2, {
    ProjectivePoint: ecdsa2.Point,
    CURVE: c
  });
}
function weierstrass(c) {
  const { CURVE, curveOpts, ecdsaOpts } = _ecdsa_legacy_opts_to_new(c);
  const Point4 = weierstrassN(CURVE, curveOpts);
  const signs = ecdsa(Point4, ecdsaOpts, curveOpts);
  return _ecdsa_new_output_to_legacy(c, signs);
}

// node_modules/@noble/curves/esm/_shortw_utils.js
function createCurve(curveDef, defHash) {
  const create = (hash) => weierstrass({ ...curveDef, hash });
  return { ...create(defHash), create };
}

// node_modules/@noble/curves/esm/secp256k1.js
var secp256k1_CURVE = {
  p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  h: BigInt(1),
  a: BigInt(0),
  b: BigInt(7),
  Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
};
var _0n6 = BigInt(0);
var _1n6 = BigInt(1);
var _2n4 = BigInt(2);
var divNearest = (a, b) => (a + b / _2n4) / b;
function sqrtMod(y) {
  const P2 = secp256k1_CURVE.p;
  const _3n4 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P2;
  const b3 = b2 * b2 * y % P2;
  const b6 = pow2(b3, _3n4, P2) * b3 % P2;
  const b9 = pow2(b6, _3n4, P2) * b3 % P2;
  const b11 = pow2(b9, _2n4, P2) * b2 % P2;
  const b22 = pow2(b11, _11n, P2) * b11 % P2;
  const b44 = pow2(b22, _22n, P2) * b22 % P2;
  const b88 = pow2(b44, _44n, P2) * b44 % P2;
  const b176 = pow2(b88, _88n, P2) * b88 % P2;
  const b220 = pow2(b176, _44n, P2) * b44 % P2;
  const b223 = pow2(b220, _3n4, P2) * b3 % P2;
  const t1 = pow2(b223, _23n, P2) * b22 % P2;
  const t2 = pow2(t1, _6n, P2) * b2 % P2;
  const root = pow2(t2, _2n4, P2);
  if (!Fpk1.eql(Fpk1.sqr(root), y))
    throw new Error("Cannot find square root");
  return root;
}
var Fpk1 = Field(secp256k1_CURVE.p, void 0, void 0, { sqrt: sqrtMod });
var secp256k1 = createCurve({
  ...secp256k1_CURVE,
  Fp: Fpk1,
  lowS: true,
  // Allow only low-S signatures by default in sign() and verify()
  endo: {
    // Endomorphism, see above
    beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
    splitScalar: (k) => {
      const n = secp256k1_CURVE.n;
      const a1 = BigInt("0x3086d221a7d46bcde86c90e49284eb15");
      const b1 = -_1n6 * BigInt("0xe4437ed6010e88286f547fa90abfe4c3");
      const a2 = BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8");
      const b2 = a1;
      const POW_2_128 = BigInt("0x100000000000000000000000000000000");
      const c1 = divNearest(b2 * k, n);
      const c2 = divNearest(-b1 * k, n);
      let k1 = mod(k - c1 * a1 - c2 * a2, n);
      let k2 = mod(-c1 * b1 - c2 * b2, n);
      const k1neg = k1 > POW_2_128;
      const k2neg = k2 > POW_2_128;
      if (k1neg)
        k1 = n - k1;
      if (k2neg)
        k2 = n - k2;
      if (k1 > POW_2_128 || k2 > POW_2_128) {
        throw new Error("splitScalar: Endomorphism failed, k=" + k);
      }
      return { k1neg, k1, k2neg, k2 };
    }
  }
}, sha256);
var TAGGED_HASH_PREFIXES = {};
function taggedHash(tag, ...messages) {
  let tagP = TAGGED_HASH_PREFIXES[tag];
  if (tagP === void 0) {
    const tagH = sha256(Uint8Array.from(tag, (c) => c.charCodeAt(0)));
    tagP = concatBytes(tagH, tagH);
    TAGGED_HASH_PREFIXES[tag] = tagP;
  }
  return sha256(concatBytes(tagP, ...messages));
}
var pointToBytes = (point) => point.toBytes(true).slice(1);
var numTo32b = (n) => numberToBytesBE(n, 32);
var modP = (x) => mod(x, secp256k1_CURVE.p);
var modN = (x) => mod(x, secp256k1_CURVE.n);
var Point = /* @__PURE__ */ (() => secp256k1.Point)();
var hasEven = (y) => y % _2n4 === _0n6;
function schnorrGetExtPubKey(priv) {
  let d_ = secp256k1.utils.normPrivateKeyToScalar(priv);
  let p = Point.fromPrivateKey(d_);
  const scalar = hasEven(p.y) ? d_ : modN(-d_);
  return { scalar, bytes: pointToBytes(p) };
}
function lift_x(x) {
  aInRange("x", x, _1n6, secp256k1_CURVE.p);
  const xx = modP(x * x);
  const c = modP(xx * x + BigInt(7));
  let y = sqrtMod(c);
  if (!hasEven(y))
    y = modP(-y);
  const p = Point.fromAffine({ x, y });
  p.assertValidity();
  return p;
}
var num = bytesToNumberBE;
function challenge(...args) {
  return modN(num(taggedHash("BIP0340/challenge", ...args)));
}
function schnorrGetPublicKey(privateKey) {
  return schnorrGetExtPubKey(privateKey).bytes;
}
function schnorrSign(message, privateKey, auxRand = randomBytes(32)) {
  const m = ensureBytes("message", message);
  const { bytes: px, scalar: d } = schnorrGetExtPubKey(privateKey);
  const a = ensureBytes("auxRand", auxRand, 32);
  const t = numTo32b(d ^ num(taggedHash("BIP0340/aux", a)));
  const rand = taggedHash("BIP0340/nonce", t, px, m);
  const k_ = modN(num(rand));
  if (k_ === _0n6)
    throw new Error("sign failed: k is zero");
  const { bytes: rx, scalar: k } = schnorrGetExtPubKey(k_);
  const e = challenge(rx, px, m);
  const sig = new Uint8Array(64);
  sig.set(rx, 0);
  sig.set(numTo32b(modN(k + e * d)), 32);
  if (!schnorrVerify(sig, m, px))
    throw new Error("sign: Invalid signature produced");
  return sig;
}
function schnorrVerify(signature, message, publicKey) {
  const sig = ensureBytes("signature", signature, 64);
  const m = ensureBytes("message", message);
  const pub = ensureBytes("publicKey", publicKey, 32);
  try {
    const P2 = lift_x(num(pub));
    const r = num(sig.subarray(0, 32));
    if (!inRange(r, _1n6, secp256k1_CURVE.p))
      return false;
    const s = num(sig.subarray(32, 64));
    if (!inRange(s, _1n6, secp256k1_CURVE.n))
      return false;
    const e = challenge(numTo32b(r), pointToBytes(P2), m);
    const R = Point.BASE.multiplyUnsafe(s).add(P2.multiplyUnsafe(modN(-e)));
    const { x, y } = R.toAffine();
    if (R.is0() || !hasEven(y) || x !== r)
      return false;
    return true;
  } catch (error) {
    return false;
  }
}
var schnorr = /* @__PURE__ */ (() => ({
  getPublicKey: schnorrGetPublicKey,
  sign: schnorrSign,
  verify: schnorrVerify,
  utils: {
    randomPrivateKey: secp256k1.utils.randomPrivateKey,
    lift_x,
    pointToBytes,
    numberToBytesBE,
    bytesToNumberBE,
    taggedHash,
    mod
  }
}))();

// node_modules/@noble/curves/esm/abstract/edwards.js
var _0n7 = BigInt(0);
var _1n7 = BigInt(1);
var _2n5 = BigInt(2);
var _8n2 = BigInt(8);
var VERIFY_DEFAULT = { zip215: true };
function isEdValidXY(Fp2, CURVE, x, y) {
  const x2 = Fp2.sqr(x);
  const y2 = Fp2.sqr(y);
  const left = Fp2.add(Fp2.mul(CURVE.a, x2), y2);
  const right = Fp2.add(Fp2.ONE, Fp2.mul(CURVE.d, Fp2.mul(x2, y2)));
  return Fp2.eql(left, right);
}
function edwards(CURVE, curveOpts = {}) {
  const { Fp: Fp2, Fn } = _createCurveFields("edwards", CURVE, curveOpts);
  const { h: cofactor, n: CURVE_ORDER2 } = CURVE;
  _validateObject(curveOpts, {}, { uvRatio: "function" });
  const MASK = _2n5 << BigInt(Fn.BYTES * 8) - _1n7;
  const modP2 = (n) => Fp2.create(n);
  const uvRatio2 = curveOpts.uvRatio || ((u, v) => {
    try {
      return { isValid: true, value: Fp2.sqrt(Fp2.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n7 };
    }
  });
  if (!isEdValidXY(Fp2, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n7 : _0n7;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aextpoint(other) {
    if (!(other instanceof Point4))
      throw new Error("ExtendedPoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { ex: x, ey: y, ez: z } = p;
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? _8n2 : Fp2.inv(z);
    const ax = modP2(x * iz);
    const ay = modP2(y * iz);
    const zz = modP2(z * iz);
    if (is0)
      return { x: _0n7, y: _1n7 };
    if (zz !== _1n7)
      throw new Error("invZ was invalid");
    return { x: ax, y: ay };
  });
  const assertValidMemo = memoized((p) => {
    const { a, d } = CURVE;
    if (p.is0())
      throw new Error("bad point: ZERO");
    const { ex: X, ey: Y, ez: Z, et: T } = p;
    const X2 = modP2(X * X);
    const Y2 = modP2(Y * Y);
    const Z2 = modP2(Z * Z);
    const Z4 = modP2(Z2 * Z2);
    const aX2 = modP2(X2 * a);
    const left = modP2(Z2 * modP2(aX2 + Y2));
    const right = modP2(Z4 + modP2(d * modP2(X2 * Y2)));
    if (left !== right)
      throw new Error("bad point: equation left != right (1)");
    const XY = modP2(X * Y);
    const ZT = modP2(Z * T);
    if (XY !== ZT)
      throw new Error("bad point: equation left != right (2)");
    return true;
  });
  class Point4 {
    constructor(ex, ey, ez, et) {
      this.ex = acoord("x", ex);
      this.ey = acoord("y", ey);
      this.ez = acoord("z", ez, true);
      this.et = acoord("t", et);
      Object.freeze(this);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    static fromAffine(p) {
      if (p instanceof Point4)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new Point4(x, y, _1n7, modP2(x * y));
    }
    static normalizeZ(points) {
      return normalizeZ(Point4, "ez", points);
    }
    // Multiscalar Multiplication
    static msm(points, scalars) {
      return pippenger(Point4, Fn, points, scalars);
    }
    // "Private method", don't use it directly
    _setWindowSize(windowSize) {
      this.precompute(windowSize);
    }
    precompute(windowSize = 8, isLazy = true) {
      wnaf.setWindowSize(this, windowSize);
      if (!isLazy)
        this.multiply(_2n5);
      return this;
    }
    // Not required for fromHex(), which always creates valid points.
    // Could be useful for fromAffine().
    assertValidity() {
      assertValidMemo(this);
    }
    // Compare one point to another.
    equals(other) {
      aextpoint(other);
      const { ex: X1, ey: Y1, ez: Z1 } = this;
      const { ex: X2, ey: Y2, ez: Z2 } = other;
      const X1Z2 = modP2(X1 * Z2);
      const X2Z1 = modP2(X2 * Z1);
      const Y1Z2 = modP2(Y1 * Z2);
      const Y2Z1 = modP2(Y2 * Z1);
      return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
    }
    is0() {
      return this.equals(Point4.ZERO);
    }
    negate() {
      return new Point4(modP2(-this.ex), this.ey, this.ez, modP2(-this.et));
    }
    // Fast algo for doubling Extended Point.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
    // Cost: 4M + 4S + 1*a + 6add + 1*2.
    double() {
      const { a } = CURVE;
      const { ex: X1, ey: Y1, ez: Z1 } = this;
      const A = modP2(X1 * X1);
      const B = modP2(Y1 * Y1);
      const C = modP2(_2n5 * modP2(Z1 * Z1));
      const D = modP2(a * A);
      const x1y1 = X1 + Y1;
      const E = modP2(modP2(x1y1 * x1y1) - A - B);
      const G2 = D + B;
      const F = G2 - C;
      const H = D - B;
      const X3 = modP2(E * F);
      const Y3 = modP2(G2 * H);
      const T3 = modP2(E * H);
      const Z3 = modP2(F * G2);
      return new Point4(X3, Y3, Z3, T3);
    }
    // Fast algo for adding 2 Extended Points.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
    // Cost: 9M + 1*a + 1*d + 7add.
    add(other) {
      aextpoint(other);
      const { a, d } = CURVE;
      const { ex: X1, ey: Y1, ez: Z1, et: T1 } = this;
      const { ex: X2, ey: Y2, ez: Z2, et: T2 } = other;
      const A = modP2(X1 * X2);
      const B = modP2(Y1 * Y2);
      const C = modP2(T1 * d * T2);
      const D = modP2(Z1 * Z2);
      const E = modP2((X1 + Y1) * (X2 + Y2) - A - B);
      const F = D - C;
      const G2 = D + C;
      const H = modP2(B - a * A);
      const X3 = modP2(E * F);
      const Y3 = modP2(G2 * H);
      const T3 = modP2(E * H);
      const Z3 = modP2(F * G2);
      return new Point4(X3, Y3, Z3, T3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    // Constant-time multiplication.
    multiply(scalar) {
      const n = scalar;
      aInRange("scalar", n, _1n7, CURVE_ORDER2);
      const { p, f } = wnaf.wNAFCached(this, n, Point4.normalizeZ);
      return Point4.normalizeZ([p, f])[0];
    }
    // Non-constant-time multiplication. Uses double-and-add algorithm.
    // It's faster, but should only be used when you don't care about
    // an exposed private key e.g. sig verification.
    // Does NOT allow scalars higher than CURVE.n.
    // Accepts optional accumulator to merge with multiply (important for sparse scalars)
    multiplyUnsafe(scalar, acc = Point4.ZERO) {
      const n = scalar;
      aInRange("scalar", n, _0n7, CURVE_ORDER2);
      if (n === _0n7)
        return Point4.ZERO;
      if (this.is0() || n === _1n7)
        return this;
      return wnaf.wNAFCachedUnsafe(this, n, Point4.normalizeZ, acc);
    }
    // Checks if point is of small order.
    // If you add something to small order point, you will have "dirty"
    // point with torsion component.
    // Multiplies point by cofactor and checks if the result is 0.
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    // Multiplies point by curve order and checks if the result is 0.
    // Returns `false` is the point is dirty.
    isTorsionFree() {
      return wnaf.wNAFCachedUnsafe(this, CURVE_ORDER2).is0();
    }
    // Converts Extended point to default (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    clearCofactor() {
      if (cofactor === _1n7)
        return this;
      return this.multiplyUnsafe(cofactor);
    }
    static fromBytes(bytes, zip215 = false) {
      abytes(bytes);
      return this.fromHex(bytes, zip215);
    }
    // Converts hash string or Uint8Array to Point.
    // Uses algo from RFC8032 5.1.3.
    static fromHex(hex2, zip215 = false) {
      const { d, a } = CURVE;
      const len = Fp2.BYTES;
      hex2 = ensureBytes("pointHex", hex2, len);
      abool("zip215", zip215);
      const normed = hex2.slice();
      const lastByte = hex2[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp2.ORDER;
      aInRange("pointHex.y", y, _0n7, max);
      const y2 = modP2(y * y);
      const u = modP2(y2 - _1n7);
      const v = modP2(d * y2 - a);
      let { isValid, value: x } = uvRatio2(u, v);
      if (!isValid)
        throw new Error("Point.fromHex: invalid y coordinate");
      const isXOdd = (x & _1n7) === _1n7;
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && x === _0n7 && isLastByteOdd)
        throw new Error("Point.fromHex: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = modP2(-x);
      return Point4.fromAffine({ x, y });
    }
    static fromPrivateScalar(scalar) {
      return Point4.BASE.multiply(scalar);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = numberToBytesLE(y, Fp2.BYTES);
      bytes[bytes.length - 1] |= x & _1n7 ? 128 : 0;
      return bytes;
    }
    /** @deprecated use `toBytes` */
    toRawBytes() {
      return this.toBytes();
    }
    toHex() {
      return bytesToHex(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  Point4.BASE = new Point4(CURVE.Gx, CURVE.Gy, _1n7, modP2(CURVE.Gx * CURVE.Gy));
  Point4.ZERO = new Point4(_0n7, _1n7, _1n7, _0n7);
  Point4.Fp = Fp2;
  Point4.Fn = Fn;
  const wnaf = wNAF(Point4, Fn.BYTES * 8);
  return Point4;
}
function eddsa(Point4, eddsaOpts) {
  _validateObject(eddsaOpts, {
    hash: "function"
  }, {
    adjustScalarBytes: "function",
    randomBytes: "function",
    domain: "function",
    prehash: "function",
    mapToCurve: "function"
  });
  const { prehash, hash: cHash } = eddsaOpts;
  const { BASE: G2, Fp: Fp2, Fn } = Point4;
  const CURVE_ORDER2 = Fn.ORDER;
  const randomBytes_ = eddsaOpts.randomBytes || randomBytes;
  const adjustScalarBytes2 = eddsaOpts.adjustScalarBytes || ((bytes) => bytes);
  const domain = eddsaOpts.domain || ((data, ctx, phflag) => {
    abool("phflag", phflag);
    if (ctx.length || phflag)
      throw new Error("Contexts/pre-hash are not supported");
    return data;
  });
  function modN2(a) {
    return Fn.create(a);
  }
  function modN_LE(hash) {
    return modN2(bytesToNumberLE(hash));
  }
  function getPrivateScalar(key) {
    const len = Fp2.BYTES;
    key = ensureBytes("private key", key, len);
    const hashed = ensureBytes("hashed private key", cHash(key), 2 * len);
    const head = adjustScalarBytes2(hashed.slice(0, len));
    const prefix2 = hashed.slice(len, 2 * len);
    const scalar = modN_LE(head);
    return { head, prefix: prefix2, scalar };
  }
  function getExtendedPublicKey(key) {
    const { head, prefix: prefix2, scalar } = getPrivateScalar(key);
    const point = G2.multiply(scalar);
    const pointBytes = point.toBytes();
    return { head, prefix: prefix2, scalar, point, pointBytes };
  }
  function getPublicKey(privKey) {
    return getExtendedPublicKey(privKey).pointBytes;
  }
  function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
    const msg = concatBytes(...msgs);
    return modN_LE(cHash(domain(msg, ensureBytes("context", context), !!prehash)));
  }
  function sign(msg, privKey, options = {}) {
    msg = ensureBytes("message", msg);
    if (prehash)
      msg = prehash(msg);
    const { prefix: prefix2, scalar, pointBytes } = getExtendedPublicKey(privKey);
    const r = hashDomainToScalar(options.context, prefix2, msg);
    const R = G2.multiply(r).toBytes();
    const k = hashDomainToScalar(options.context, R, pointBytes, msg);
    const s = modN2(r + k * scalar);
    aInRange("signature.s", s, _0n7, CURVE_ORDER2);
    const L = Fp2.BYTES;
    const res = concatBytes(R, numberToBytesLE(s, L));
    return ensureBytes("result", res, L * 2);
  }
  const verifyOpts = VERIFY_DEFAULT;
  function verify(sig, msg, publicKey, options = verifyOpts) {
    const { context, zip215 } = options;
    const len = Fp2.BYTES;
    sig = ensureBytes("signature", sig, 2 * len);
    msg = ensureBytes("message", msg);
    publicKey = ensureBytes("publicKey", publicKey, len);
    if (zip215 !== void 0)
      abool("zip215", zip215);
    if (prehash)
      msg = prehash(msg);
    const s = bytesToNumberLE(sig.slice(len, 2 * len));
    let A, R, SB;
    try {
      A = Point4.fromHex(publicKey, zip215);
      R = Point4.fromHex(sig.slice(0, len), zip215);
      SB = G2.multiplyUnsafe(s);
    } catch (error) {
      return false;
    }
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = hashDomainToScalar(context, R.toBytes(), A.toBytes(), msg);
    const RkA = R.add(A.multiplyUnsafe(k));
    return RkA.subtract(SB).clearCofactor().is0();
  }
  G2.precompute(8);
  const utils4 = {
    getExtendedPublicKey,
    /** ed25519 priv keys are uniform 32b. No need to check for modulo bias, like in secp256k1. */
    randomPrivateKey: () => randomBytes_(Fp2.BYTES),
    /**
     * We're doing scalar multiplication (used in getPublicKey etc) with precomputed BASE_POINT
     * values. This slows down first getPublicKey() by milliseconds (see Speed section),
     * but allows to speed-up subsequent getPublicKey() calls up to 20x.
     * @param windowSize 2, 4, 8, 16
     */
    precompute(windowSize = 8, point = Point4.BASE) {
      return point.precompute(windowSize, false);
    }
  };
  return { getPublicKey, sign, verify, utils: utils4, Point: Point4 };
}
function _eddsa_legacy_opts_to_new(c) {
  const CURVE = {
    a: c.a,
    d: c.d,
    p: c.Fp.ORDER,
    n: c.n,
    h: c.h,
    Gx: c.Gx,
    Gy: c.Gy
  };
  const Fp2 = c.Fp;
  const Fn = Field(CURVE.n, c.nBitLength, true);
  const curveOpts = { Fp: Fp2, Fn, uvRatio: c.uvRatio };
  const eddsaOpts = {
    hash: c.hash,
    randomBytes: c.randomBytes,
    adjustScalarBytes: c.adjustScalarBytes,
    domain: c.domain,
    prehash: c.prehash,
    mapToCurve: c.mapToCurve
  };
  return { CURVE, curveOpts, eddsaOpts };
}
function _eddsa_new_output_to_legacy(c, eddsa2) {
  const legacy = Object.assign({}, eddsa2, { ExtendedPoint: eddsa2.Point, CURVE: c });
  return legacy;
}
function twistedEdwards(c) {
  const { CURVE, curveOpts, eddsaOpts } = _eddsa_legacy_opts_to_new(c);
  const Point4 = edwards(CURVE, curveOpts);
  const EDDSA = eddsa(Point4, eddsaOpts);
  return _eddsa_new_output_to_legacy(c, EDDSA);
}

// node_modules/@noble/curves/esm/ed25519.js
var _0n8 = BigInt(0);
var _1n8 = BigInt(1);
var _2n6 = BigInt(2);
var _3n3 = BigInt(3);
var _5n2 = BigInt(5);
var _8n3 = BigInt(8);
var ed25519_CURVE = {
  p: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed"),
  n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
  h: _8n3,
  a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
  d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
  Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
  Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
};
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P2 = ed25519_CURVE.p;
  const x2 = x * x % P2;
  const b2 = x2 * x % P2;
  const b4 = pow2(b2, _2n6, P2) * b2 % P2;
  const b5 = pow2(b4, _1n8, P2) * x % P2;
  const b10 = pow2(b5, _5n2, P2) * b5 % P2;
  const b20 = pow2(b10, _10n, P2) * b10 % P2;
  const b40 = pow2(b20, _20n, P2) * b20 % P2;
  const b80 = pow2(b40, _40n, P2) * b40 % P2;
  const b160 = pow2(b80, _80n, P2) * b80 % P2;
  const b240 = pow2(b160, _80n, P2) * b80 % P2;
  const b250 = pow2(b240, _10n, P2) * b10 % P2;
  const pow_p_5_8 = pow2(b250, _2n6, P2) * x % P2;
  return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes) {
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return bytes;
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio(u, v) {
  const P2 = ed25519_CURVE.p;
  const v3 = mod(v * v * v, P2);
  const v7 = mod(v3 * v3 * v, P2);
  const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow, P2);
  const vx2 = mod(v * x * x, P2);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P2);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P2);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P2);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P2))
    x = mod(-x, P2);
  return { isValid: useRoot1 || useRoot2, value: x };
}
var Fp = /* @__PURE__ */ (() => Field(ed25519_CURVE.p, void 0, true))();
var ed25519Defaults = /* @__PURE__ */ (() => ({
  ...ed25519_CURVE,
  Fp,
  hash: sha512,
  adjustScalarBytes,
  // dom2
  // Ratio of u to v. Allows us to combine inversion and square root. Uses algo from RFC8032 5.1.3.
  // Constant-time, u/√v
  uvRatio
}))();
var ed25519 = /* @__PURE__ */ (() => twistedEdwards(ed25519Defaults))();

// node_modules/@scure/bip39/esm/index.js
var esm_exports = {};
__export(esm_exports, {
  entropyToMnemonic: () => entropyToMnemonic,
  generateMnemonic: () => generateMnemonic,
  mnemonicToEntropy: () => mnemonicToEntropy,
  mnemonicToSeed: () => mnemonicToSeed,
  mnemonicToSeedSync: () => mnemonicToSeedSync,
  validateMnemonic: () => validateMnemonic
});

// node_modules/@scure/base/lib/esm/index.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes2(b, ...lengths) {
  if (!isBytes2(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function isArrayOf(isString, arr) {
  if (!Array.isArray(arr))
    return false;
  if (arr.length === 0)
    return true;
  if (isString) {
    return arr.every((item) => typeof item === "string");
  } else {
    return arr.every((item) => Number.isSafeInteger(item));
  }
}
function afn(input) {
  if (typeof input !== "function")
    throw new Error("function expected");
  return true;
}
function astr(label, input) {
  if (typeof input !== "string")
    throw new Error(`${label}: string expected`);
  return true;
}
function anumber2(n) {
  if (!Number.isSafeInteger(n))
    throw new Error(`invalid integer: ${n}`);
}
function aArr(input) {
  if (!Array.isArray(input))
    throw new Error("array expected");
}
function astrArr(label, input) {
  if (!isArrayOf(true, input))
    throw new Error(`${label}: array of strings expected`);
}
function anumArr(label, input) {
  if (!isArrayOf(false, input))
    throw new Error(`${label}: array of numbers expected`);
}
// @__NO_SIDE_EFFECTS__
function chain(...args) {
  const id = (a) => a;
  const wrap2 = (a, b) => (c) => a(b(c));
  const encode = args.map((x) => x.encode).reduceRight(wrap2, id);
  const decode = args.map((x) => x.decode).reduce(wrap2, id);
  return { encode, decode };
}
// @__NO_SIDE_EFFECTS__
function alphabet(letters) {
  const lettersA = typeof letters === "string" ? letters.split("") : letters;
  const len = lettersA.length;
  astrArr("alphabet", lettersA);
  const indexes = new Map(lettersA.map((l, i) => [l, i]));
  return {
    encode: (digits) => {
      aArr(digits);
      return digits.map((i) => {
        if (!Number.isSafeInteger(i) || i < 0 || i >= len)
          throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);
        return lettersA[i];
      });
    },
    decode: (input) => {
      aArr(input);
      return input.map((letter) => {
        astr("alphabet.decode", letter);
        const i = indexes.get(letter);
        if (i === void 0)
          throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
        return i;
      });
    }
  };
}
// @__NO_SIDE_EFFECTS__
function join(separator = "") {
  astr("join", separator);
  return {
    encode: (from) => {
      astrArr("join.decode", from);
      return from.join(separator);
    },
    decode: (to) => {
      astr("join.decode", to);
      return to.split(separator);
    }
  };
}
// @__NO_SIDE_EFFECTS__
function padding(bits, chr = "=") {
  anumber2(bits);
  astr("padding", chr);
  return {
    encode(data) {
      astrArr("padding.encode", data);
      while (data.length * bits % 8)
        data.push(chr);
      return data;
    },
    decode(input) {
      astrArr("padding.decode", input);
      let end = input.length;
      if (end * bits % 8)
        throw new Error("padding: invalid, string should have whole number of bytes");
      for (; end > 0 && input[end - 1] === chr; end--) {
        const last = end - 1;
        const byte = last * bits;
        if (byte % 8 === 0)
          throw new Error("padding: invalid, string has too much padding");
      }
      return input.slice(0, end);
    }
  };
}
// @__NO_SIDE_EFFECTS__
function normalize(fn) {
  afn(fn);
  return { encode: (from) => from, decode: (to) => fn(to) };
}
function convertRadix(data, from, to) {
  if (from < 2)
    throw new Error(`convertRadix: invalid from=${from}, base cannot be less than 2`);
  if (to < 2)
    throw new Error(`convertRadix: invalid to=${to}, base cannot be less than 2`);
  aArr(data);
  if (!data.length)
    return [];
  let pos = 0;
  const res = [];
  const digits = Array.from(data, (d) => {
    anumber2(d);
    if (d < 0 || d >= from)
      throw new Error(`invalid integer: ${d}`);
    return d;
  });
  const dlen = digits.length;
  while (true) {
    let carry = 0;
    let done = true;
    for (let i = pos; i < dlen; i++) {
      const digit = digits[i];
      const fromCarry = from * carry;
      const digitBase = fromCarry + digit;
      if (!Number.isSafeInteger(digitBase) || fromCarry / from !== carry || digitBase - digit !== fromCarry) {
        throw new Error("convertRadix: carry overflow");
      }
      const div = digitBase / to;
      carry = digitBase % to;
      const rounded = Math.floor(div);
      digits[i] = rounded;
      if (!Number.isSafeInteger(rounded) || rounded * to + carry !== digitBase)
        throw new Error("convertRadix: carry overflow");
      if (!done)
        continue;
      else if (!rounded)
        pos = i;
      else
        done = false;
    }
    res.push(carry);
    if (done)
      break;
  }
  for (let i = 0; i < data.length - 1 && data[i] === 0; i++)
    res.push(0);
  return res.reverse();
}
var gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
var radix2carry = /* @__NO_SIDE_EFFECTS__ */ (from, to) => from + (to - gcd(from, to));
var powers = /* @__PURE__ */ (() => {
  let res = [];
  for (let i = 0; i < 40; i++)
    res.push(2 ** i);
  return res;
})();
function convertRadix2(data, from, to, padding2) {
  aArr(data);
  if (from <= 0 || from > 32)
    throw new Error(`convertRadix2: wrong from=${from}`);
  if (to <= 0 || to > 32)
    throw new Error(`convertRadix2: wrong to=${to}`);
  if (/* @__PURE__ */ radix2carry(from, to) > 32) {
    throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${/* @__PURE__ */ radix2carry(from, to)}`);
  }
  let carry = 0;
  let pos = 0;
  const max = powers[from];
  const mask = powers[to] - 1;
  const res = [];
  for (const n of data) {
    anumber2(n);
    if (n >= max)
      throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
    carry = carry << from | n;
    if (pos + from > 32)
      throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
    pos += from;
    for (; pos >= to; pos -= to)
      res.push((carry >> pos - to & mask) >>> 0);
    const pow = powers[pos];
    if (pow === void 0)
      throw new Error("invalid carry");
    carry &= pow - 1;
  }
  carry = carry << to - pos & mask;
  if (!padding2 && pos >= from)
    throw new Error("Excess padding");
  if (!padding2 && carry > 0)
    throw new Error(`Non-zero padding: ${carry}`);
  if (padding2 && pos > 0)
    res.push(carry >>> 0);
  return res;
}
// @__NO_SIDE_EFFECTS__
function radix(num2) {
  anumber2(num2);
  const _256 = 2 ** 8;
  return {
    encode: (bytes) => {
      if (!isBytes2(bytes))
        throw new Error("radix.encode input should be Uint8Array");
      return convertRadix(Array.from(bytes), _256, num2);
    },
    decode: (digits) => {
      anumArr("radix.decode", digits);
      return Uint8Array.from(convertRadix(digits, num2, _256));
    }
  };
}
// @__NO_SIDE_EFFECTS__
function radix2(bits, revPadding = false) {
  anumber2(bits);
  if (bits <= 0 || bits > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (/* @__PURE__ */ radix2carry(8, bits) > 32 || /* @__PURE__ */ radix2carry(bits, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (bytes) => {
      if (!isBytes2(bytes))
        throw new Error("radix2.encode input should be Uint8Array");
      return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
    },
    decode: (digits) => {
      anumArr("radix2.decode", digits);
      return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
    }
  };
}
function unsafeWrapper(fn) {
  afn(fn);
  return function(...args) {
    try {
      return fn.apply(null, args);
    } catch (e) {
    }
  };
}
function checksum(len, fn) {
  anumber2(len);
  afn(fn);
  return {
    encode(data) {
      if (!isBytes2(data))
        throw new Error("checksum.encode: input should be Uint8Array");
      const sum = fn(data).slice(0, len);
      const res = new Uint8Array(data.length + len);
      res.set(data);
      res.set(sum, data.length);
      return res;
    },
    decode(data) {
      if (!isBytes2(data))
        throw new Error("checksum.decode: input should be Uint8Array");
      const payload = data.slice(0, -len);
      const oldChecksum = data.slice(-len);
      const newChecksum = fn(payload).slice(0, len);
      for (let i = 0; i < len; i++)
        if (newChecksum[i] !== oldChecksum[i])
          throw new Error("Invalid checksum");
      return payload;
    }
  };
}
var utils = {
  alphabet,
  chain,
  checksum,
  convertRadix,
  convertRadix2,
  radix,
  radix2,
  join,
  padding
};
var hasBase64Builtin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toBase64 === "function" && typeof Uint8Array.fromBase64 === "function")();
var decodeBase64Builtin = (s, isUrl) => {
  astr("base64", s);
  const re = isUrl ? /^[A-Za-z0-9=_-]+$/ : /^[A-Za-z0-9=+/]+$/;
  const alphabet2 = isUrl ? "base64url" : "base64";
  if (s.length > 0 && !re.test(s))
    throw new Error("invalid base64");
  return Uint8Array.fromBase64(s, { alphabet: alphabet2, lastChunkHandling: "strict" });
};
var base64 = hasBase64Builtin ? {
  encode(b) {
    abytes2(b);
    return b.toBase64();
  },
  decode(s) {
    return decodeBase64Builtin(s, false);
  }
} : /* @__PURE__ */ chain(/* @__PURE__ */ radix2(6), /* @__PURE__ */ alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), /* @__PURE__ */ padding(6), /* @__PURE__ */ join(""));
var genBase58 = /* @__NO_SIDE_EFFECTS__ */ (abc) => /* @__PURE__ */ chain(/* @__PURE__ */ radix(58), /* @__PURE__ */ alphabet(abc), /* @__PURE__ */ join(""));
var base58 = /* @__PURE__ */ genBase58("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");
var createBase58check = (sha2562) => /* @__PURE__ */ chain(checksum(4, (data) => sha2562(sha2562(data))), base58);
var base58check = createBase58check;
var BECH_ALPHABET = /* @__PURE__ */ chain(/* @__PURE__ */ alphabet("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), /* @__PURE__ */ join(""));
var POLYMOD_GENERATORS = [996825010, 642813549, 513874426, 1027748829, 705979059];
function bech32Polymod(pre) {
  const b = pre >> 25;
  let chk = (pre & 33554431) << 5;
  for (let i = 0; i < POLYMOD_GENERATORS.length; i++) {
    if ((b >> i & 1) === 1)
      chk ^= POLYMOD_GENERATORS[i];
  }
  return chk;
}
function bechChecksum(prefix2, words, encodingConst = 1) {
  const len = prefix2.length;
  let chk = 1;
  for (let i = 0; i < len; i++) {
    const c = prefix2.charCodeAt(i);
    if (c < 33 || c > 126)
      throw new Error(`Invalid prefix (${prefix2})`);
    chk = bech32Polymod(chk) ^ c >> 5;
  }
  chk = bech32Polymod(chk);
  for (let i = 0; i < len; i++)
    chk = bech32Polymod(chk) ^ prefix2.charCodeAt(i) & 31;
  for (let v of words)
    chk = bech32Polymod(chk) ^ v;
  for (let i = 0; i < 6; i++)
    chk = bech32Polymod(chk);
  chk ^= encodingConst;
  return BECH_ALPHABET.encode(convertRadix2([chk % powers[30]], 30, 5, false));
}
// @__NO_SIDE_EFFECTS__
function genBech32(encoding) {
  const ENCODING_CONST = encoding === "bech32" ? 1 : 734539939;
  const _words = /* @__PURE__ */ radix2(5);
  const fromWords = _words.decode;
  const toWords = _words.encode;
  const fromWordsUnsafe = unsafeWrapper(fromWords);
  function encode(prefix2, words, limit = 90) {
    astr("bech32.encode prefix", prefix2);
    if (isBytes2(words))
      words = Array.from(words);
    anumArr("bech32.encode", words);
    const plen = prefix2.length;
    if (plen === 0)
      throw new TypeError(`Invalid prefix length ${plen}`);
    const actualLength = plen + 7 + words.length;
    if (limit !== false && actualLength > limit)
      throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
    const lowered = prefix2.toLowerCase();
    const sum = bechChecksum(lowered, words, ENCODING_CONST);
    return `${lowered}1${BECH_ALPHABET.encode(words)}${sum}`;
  }
  function decode(str, limit = 90) {
    astr("bech32.decode input", str);
    const slen = str.length;
    if (slen < 8 || limit !== false && slen > limit)
      throw new TypeError(`invalid string length: ${slen} (${str}). Expected (8..${limit})`);
    const lowered = str.toLowerCase();
    if (str !== lowered && str !== str.toUpperCase())
      throw new Error(`String must be lowercase or uppercase`);
    const sepIndex = lowered.lastIndexOf("1");
    if (sepIndex === 0 || sepIndex === -1)
      throw new Error(`Letter "1" must be present between prefix and data only`);
    const prefix2 = lowered.slice(0, sepIndex);
    const data = lowered.slice(sepIndex + 1);
    if (data.length < 6)
      throw new Error("Data must be at least 6 characters long");
    const words = BECH_ALPHABET.decode(data).slice(0, -6);
    const sum = bechChecksum(prefix2, words, ENCODING_CONST);
    if (!data.endsWith(sum))
      throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
    return { prefix: prefix2, words };
  }
  const decodeUnsafe = unsafeWrapper(decode);
  function decodeToBytes(str) {
    const { prefix: prefix2, words } = decode(str, false);
    return { prefix: prefix2, words, bytes: fromWords(words) };
  }
  function encodeFromBytes(prefix2, bytes) {
    return encode(prefix2, toWords(bytes));
  }
  return {
    encode,
    decode,
    encodeFromBytes,
    decodeToBytes,
    decodeUnsafe,
    fromWords,
    fromWordsUnsafe,
    toWords
  };
}
var bech32 = /* @__PURE__ */ genBech32("bech32");
var bech32m = /* @__PURE__ */ genBech32("bech32m");
var utf8 = {
  encode: (data) => new TextDecoder().decode(data),
  decode: (str) => new TextEncoder().encode(str)
};
var hasHexBuiltin2 = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexBuiltin = {
  encode(data) {
    abytes2(data);
    return data.toHex();
  },
  decode(s) {
    astr("hex", s);
    return Uint8Array.fromHex(s);
  }
};
var hex = hasHexBuiltin2 ? hexBuiltin : /* @__PURE__ */ chain(/* @__PURE__ */ radix2(4), /* @__PURE__ */ alphabet("0123456789abcdef"), /* @__PURE__ */ join(""), /* @__PURE__ */ normalize((s) => {
  if (typeof s !== "string" || s.length % 2 !== 0)
    throw new TypeError(`hex.decode: expected string, got ${typeof s} with length ${s.length}`);
  return s.toLowerCase();
}));

// node_modules/@scure/bip39/esm/index.js
var isJapanese = (wordlist2) => wordlist2[0] === "\u3042\u3044\u3053\u304F\u3057\u3093";
function nfkd(str) {
  if (typeof str !== "string")
    throw new TypeError("invalid mnemonic type: " + typeof str);
  return str.normalize("NFKD");
}
function normalize2(str) {
  const norm = nfkd(str);
  const words = norm.split(" ");
  if (![12, 15, 18, 21, 24].includes(words.length))
    throw new Error("Invalid mnemonic");
  return { nfkd: norm, words };
}
function aentropy(ent) {
  abytes(ent, 16, 20, 24, 28, 32);
}
function generateMnemonic(wordlist2, strength = 128) {
  anumber(strength);
  if (strength % 32 !== 0 || strength > 256)
    throw new TypeError("Invalid entropy");
  return entropyToMnemonic(randomBytes(strength / 8), wordlist2);
}
var calcChecksum = (entropy) => {
  const bitsLeft = 8 - entropy.length / 4;
  return new Uint8Array([sha256(entropy)[0] >> bitsLeft << bitsLeft]);
};
function getCoder(wordlist2) {
  if (!Array.isArray(wordlist2) || wordlist2.length !== 2048 || typeof wordlist2[0] !== "string")
    throw new Error("Wordlist: expected array of 2048 strings");
  wordlist2.forEach((i) => {
    if (typeof i !== "string")
      throw new Error("wordlist: non-string element: " + i);
  });
  return utils.chain(utils.checksum(1, calcChecksum), utils.radix2(11, true), utils.alphabet(wordlist2));
}
function mnemonicToEntropy(mnemonic, wordlist2) {
  const { words } = normalize2(mnemonic);
  const entropy = getCoder(wordlist2).decode(words);
  aentropy(entropy);
  return entropy;
}
function entropyToMnemonic(entropy, wordlist2) {
  aentropy(entropy);
  const words = getCoder(wordlist2).encode(entropy);
  return words.join(isJapanese(wordlist2) ? "\u3000" : " ");
}
function validateMnemonic(mnemonic, wordlist2) {
  try {
    mnemonicToEntropy(mnemonic, wordlist2);
  } catch (e) {
    return false;
  }
  return true;
}
var psalt = (passphrase) => nfkd("mnemonic" + passphrase);
function mnemonicToSeed(mnemonic, passphrase = "") {
  return pbkdf2Async(sha512, normalize2(mnemonic).nfkd, psalt(passphrase), { c: 2048, dkLen: 64 });
}
function mnemonicToSeedSync(mnemonic, passphrase = "") {
  return pbkdf2(sha512, normalize2(mnemonic).nfkd, psalt(passphrase), { c: 2048, dkLen: 64 });
}

// node_modules/@scure/bip39/esm/wordlists/english.js
var wordlist = `abandon
ability
able
about
above
absent
absorb
abstract
absurd
abuse
access
accident
account
accuse
achieve
acid
acoustic
acquire
across
act
action
actor
actress
actual
adapt
add
addict
address
adjust
admit
adult
advance
advice
aerobic
affair
afford
afraid
again
age
agent
agree
ahead
aim
air
airport
aisle
alarm
album
alcohol
alert
alien
all
alley
allow
almost
alone
alpha
already
also
alter
always
amateur
amazing
among
amount
amused
analyst
anchor
ancient
anger
angle
angry
animal
ankle
announce
annual
another
answer
antenna
antique
anxiety
any
apart
apology
appear
apple
approve
april
arch
arctic
area
arena
argue
arm
armed
armor
army
around
arrange
arrest
arrive
arrow
art
artefact
artist
artwork
ask
aspect
assault
asset
assist
assume
asthma
athlete
atom
attack
attend
attitude
attract
auction
audit
august
aunt
author
auto
autumn
average
avocado
avoid
awake
aware
away
awesome
awful
awkward
axis
baby
bachelor
bacon
badge
bag
balance
balcony
ball
bamboo
banana
banner
bar
barely
bargain
barrel
base
basic
basket
battle
beach
bean
beauty
because
become
beef
before
begin
behave
behind
believe
below
belt
bench
benefit
best
betray
better
between
beyond
bicycle
bid
bike
bind
biology
bird
birth
bitter
black
blade
blame
blanket
blast
bleak
bless
blind
blood
blossom
blouse
blue
blur
blush
board
boat
body
boil
bomb
bone
bonus
book
boost
border
boring
borrow
boss
bottom
bounce
box
boy
bracket
brain
brand
brass
brave
bread
breeze
brick
bridge
brief
bright
bring
brisk
broccoli
broken
bronze
broom
brother
brown
brush
bubble
buddy
budget
buffalo
build
bulb
bulk
bullet
bundle
bunker
burden
burger
burst
bus
business
busy
butter
buyer
buzz
cabbage
cabin
cable
cactus
cage
cake
call
calm
camera
camp
can
canal
cancel
candy
cannon
canoe
canvas
canyon
capable
capital
captain
car
carbon
card
cargo
carpet
carry
cart
case
cash
casino
castle
casual
cat
catalog
catch
category
cattle
caught
cause
caution
cave
ceiling
celery
cement
census
century
cereal
certain
chair
chalk
champion
change
chaos
chapter
charge
chase
chat
cheap
check
cheese
chef
cherry
chest
chicken
chief
child
chimney
choice
choose
chronic
chuckle
chunk
churn
cigar
cinnamon
circle
citizen
city
civil
claim
clap
clarify
claw
clay
clean
clerk
clever
click
client
cliff
climb
clinic
clip
clock
clog
close
cloth
cloud
clown
club
clump
cluster
clutch
coach
coast
coconut
code
coffee
coil
coin
collect
color
column
combine
come
comfort
comic
common
company
concert
conduct
confirm
congress
connect
consider
control
convince
cook
cool
copper
copy
coral
core
corn
correct
cost
cotton
couch
country
couple
course
cousin
cover
coyote
crack
cradle
craft
cram
crane
crash
crater
crawl
crazy
cream
credit
creek
crew
cricket
crime
crisp
critic
crop
cross
crouch
crowd
crucial
cruel
cruise
crumble
crunch
crush
cry
crystal
cube
culture
cup
cupboard
curious
current
curtain
curve
cushion
custom
cute
cycle
dad
damage
damp
dance
danger
daring
dash
daughter
dawn
day
deal
debate
debris
decade
december
decide
decline
decorate
decrease
deer
defense
define
defy
degree
delay
deliver
demand
demise
denial
dentist
deny
depart
depend
deposit
depth
deputy
derive
describe
desert
design
desk
despair
destroy
detail
detect
develop
device
devote
diagram
dial
diamond
diary
dice
diesel
diet
differ
digital
dignity
dilemma
dinner
dinosaur
direct
dirt
disagree
discover
disease
dish
dismiss
disorder
display
distance
divert
divide
divorce
dizzy
doctor
document
dog
doll
dolphin
domain
donate
donkey
donor
door
dose
double
dove
draft
dragon
drama
drastic
draw
dream
dress
drift
drill
drink
drip
drive
drop
drum
dry
duck
dumb
dune
during
dust
dutch
duty
dwarf
dynamic
eager
eagle
early
earn
earth
easily
east
easy
echo
ecology
economy
edge
edit
educate
effort
egg
eight
either
elbow
elder
electric
elegant
element
elephant
elevator
elite
else
embark
embody
embrace
emerge
emotion
employ
empower
empty
enable
enact
end
endless
endorse
enemy
energy
enforce
engage
engine
enhance
enjoy
enlist
enough
enrich
enroll
ensure
enter
entire
entry
envelope
episode
equal
equip
era
erase
erode
erosion
error
erupt
escape
essay
essence
estate
eternal
ethics
evidence
evil
evoke
evolve
exact
example
excess
exchange
excite
exclude
excuse
execute
exercise
exhaust
exhibit
exile
exist
exit
exotic
expand
expect
expire
explain
expose
express
extend
extra
eye
eyebrow
fabric
face
faculty
fade
faint
faith
fall
false
fame
family
famous
fan
fancy
fantasy
farm
fashion
fat
fatal
father
fatigue
fault
favorite
feature
february
federal
fee
feed
feel
female
fence
festival
fetch
fever
few
fiber
fiction
field
figure
file
film
filter
final
find
fine
finger
finish
fire
firm
first
fiscal
fish
fit
fitness
fix
flag
flame
flash
flat
flavor
flee
flight
flip
float
flock
floor
flower
fluid
flush
fly
foam
focus
fog
foil
fold
follow
food
foot
force
forest
forget
fork
fortune
forum
forward
fossil
foster
found
fox
fragile
frame
frequent
fresh
friend
fringe
frog
front
frost
frown
frozen
fruit
fuel
fun
funny
furnace
fury
future
gadget
gain
galaxy
gallery
game
gap
garage
garbage
garden
garlic
garment
gas
gasp
gate
gather
gauge
gaze
general
genius
genre
gentle
genuine
gesture
ghost
giant
gift
giggle
ginger
giraffe
girl
give
glad
glance
glare
glass
glide
glimpse
globe
gloom
glory
glove
glow
glue
goat
goddess
gold
good
goose
gorilla
gospel
gossip
govern
gown
grab
grace
grain
grant
grape
grass
gravity
great
green
grid
grief
grit
grocery
group
grow
grunt
guard
guess
guide
guilt
guitar
gun
gym
habit
hair
half
hammer
hamster
hand
happy
harbor
hard
harsh
harvest
hat
have
hawk
hazard
head
health
heart
heavy
hedgehog
height
hello
helmet
help
hen
hero
hidden
high
hill
hint
hip
hire
history
hobby
hockey
hold
hole
holiday
hollow
home
honey
hood
hope
horn
horror
horse
hospital
host
hotel
hour
hover
hub
huge
human
humble
humor
hundred
hungry
hunt
hurdle
hurry
hurt
husband
hybrid
ice
icon
idea
identify
idle
ignore
ill
illegal
illness
image
imitate
immense
immune
impact
impose
improve
impulse
inch
include
income
increase
index
indicate
indoor
industry
infant
inflict
inform
inhale
inherit
initial
inject
injury
inmate
inner
innocent
input
inquiry
insane
insect
inside
inspire
install
intact
interest
into
invest
invite
involve
iron
island
isolate
issue
item
ivory
jacket
jaguar
jar
jazz
jealous
jeans
jelly
jewel
job
join
joke
journey
joy
judge
juice
jump
jungle
junior
junk
just
kangaroo
keen
keep
ketchup
key
kick
kid
kidney
kind
kingdom
kiss
kit
kitchen
kite
kitten
kiwi
knee
knife
knock
know
lab
label
labor
ladder
lady
lake
lamp
language
laptop
large
later
latin
laugh
laundry
lava
law
lawn
lawsuit
layer
lazy
leader
leaf
learn
leave
lecture
left
leg
legal
legend
leisure
lemon
lend
length
lens
leopard
lesson
letter
level
liar
liberty
library
license
life
lift
light
like
limb
limit
link
lion
liquid
list
little
live
lizard
load
loan
lobster
local
lock
logic
lonely
long
loop
lottery
loud
lounge
love
loyal
lucky
luggage
lumber
lunar
lunch
luxury
lyrics
machine
mad
magic
magnet
maid
mail
main
major
make
mammal
man
manage
mandate
mango
mansion
manual
maple
marble
march
margin
marine
market
marriage
mask
mass
master
match
material
math
matrix
matter
maximum
maze
meadow
mean
measure
meat
mechanic
medal
media
melody
melt
member
memory
mention
menu
mercy
merge
merit
merry
mesh
message
metal
method
middle
midnight
milk
million
mimic
mind
minimum
minor
minute
miracle
mirror
misery
miss
mistake
mix
mixed
mixture
mobile
model
modify
mom
moment
monitor
monkey
monster
month
moon
moral
more
morning
mosquito
mother
motion
motor
mountain
mouse
move
movie
much
muffin
mule
multiply
muscle
museum
mushroom
music
must
mutual
myself
mystery
myth
naive
name
napkin
narrow
nasty
nation
nature
near
neck
need
negative
neglect
neither
nephew
nerve
nest
net
network
neutral
never
news
next
nice
night
noble
noise
nominee
noodle
normal
north
nose
notable
note
nothing
notice
novel
now
nuclear
number
nurse
nut
oak
obey
object
oblige
obscure
observe
obtain
obvious
occur
ocean
october
odor
off
offer
office
often
oil
okay
old
olive
olympic
omit
once
one
onion
online
only
open
opera
opinion
oppose
option
orange
orbit
orchard
order
ordinary
organ
orient
original
orphan
ostrich
other
outdoor
outer
output
outside
oval
oven
over
own
owner
oxygen
oyster
ozone
pact
paddle
page
pair
palace
palm
panda
panel
panic
panther
paper
parade
parent
park
parrot
party
pass
patch
path
patient
patrol
pattern
pause
pave
payment
peace
peanut
pear
peasant
pelican
pen
penalty
pencil
people
pepper
perfect
permit
person
pet
phone
photo
phrase
physical
piano
picnic
picture
piece
pig
pigeon
pill
pilot
pink
pioneer
pipe
pistol
pitch
pizza
place
planet
plastic
plate
play
please
pledge
pluck
plug
plunge
poem
poet
point
polar
pole
police
pond
pony
pool
popular
portion
position
possible
post
potato
pottery
poverty
powder
power
practice
praise
predict
prefer
prepare
present
pretty
prevent
price
pride
primary
print
priority
prison
private
prize
problem
process
produce
profit
program
project
promote
proof
property
prosper
protect
proud
provide
public
pudding
pull
pulp
pulse
pumpkin
punch
pupil
puppy
purchase
purity
purpose
purse
push
put
puzzle
pyramid
quality
quantum
quarter
question
quick
quit
quiz
quote
rabbit
raccoon
race
rack
radar
radio
rail
rain
raise
rally
ramp
ranch
random
range
rapid
rare
rate
rather
raven
raw
razor
ready
real
reason
rebel
rebuild
recall
receive
recipe
record
recycle
reduce
reflect
reform
refuse
region
regret
regular
reject
relax
release
relief
rely
remain
remember
remind
remove
render
renew
rent
reopen
repair
repeat
replace
report
require
rescue
resemble
resist
resource
response
result
retire
retreat
return
reunion
reveal
review
reward
rhythm
rib
ribbon
rice
rich
ride
ridge
rifle
right
rigid
ring
riot
ripple
risk
ritual
rival
river
road
roast
robot
robust
rocket
romance
roof
rookie
room
rose
rotate
rough
round
route
royal
rubber
rude
rug
rule
run
runway
rural
sad
saddle
sadness
safe
sail
salad
salmon
salon
salt
salute
same
sample
sand
satisfy
satoshi
sauce
sausage
save
say
scale
scan
scare
scatter
scene
scheme
school
science
scissors
scorpion
scout
scrap
screen
script
scrub
sea
search
season
seat
second
secret
section
security
seed
seek
segment
select
sell
seminar
senior
sense
sentence
series
service
session
settle
setup
seven
shadow
shaft
shallow
share
shed
shell
sheriff
shield
shift
shine
ship
shiver
shock
shoe
shoot
shop
short
shoulder
shove
shrimp
shrug
shuffle
shy
sibling
sick
side
siege
sight
sign
silent
silk
silly
silver
similar
simple
since
sing
siren
sister
situate
six
size
skate
sketch
ski
skill
skin
skirt
skull
slab
slam
sleep
slender
slice
slide
slight
slim
slogan
slot
slow
slush
small
smart
smile
smoke
smooth
snack
snake
snap
sniff
snow
soap
soccer
social
sock
soda
soft
solar
soldier
solid
solution
solve
someone
song
soon
sorry
sort
soul
sound
soup
source
south
space
spare
spatial
spawn
speak
special
speed
spell
spend
sphere
spice
spider
spike
spin
spirit
split
spoil
sponsor
spoon
sport
spot
spray
spread
spring
spy
square
squeeze
squirrel
stable
stadium
staff
stage
stairs
stamp
stand
start
state
stay
steak
steel
stem
step
stereo
stick
still
sting
stock
stomach
stone
stool
story
stove
strategy
street
strike
strong
struggle
student
stuff
stumble
style
subject
submit
subway
success
such
sudden
suffer
sugar
suggest
suit
summer
sun
sunny
sunset
super
supply
supreme
sure
surface
surge
surprise
surround
survey
suspect
sustain
swallow
swamp
swap
swarm
swear
sweet
swift
swim
swing
switch
sword
symbol
symptom
syrup
system
table
tackle
tag
tail
talent
talk
tank
tape
target
task
taste
tattoo
taxi
teach
team
tell
ten
tenant
tennis
tent
term
test
text
thank
that
theme
then
theory
there
they
thing
this
thought
three
thrive
throw
thumb
thunder
ticket
tide
tiger
tilt
timber
time
tiny
tip
tired
tissue
title
toast
tobacco
today
toddler
toe
together
toilet
token
tomato
tomorrow
tone
tongue
tonight
tool
tooth
top
topic
topple
torch
tornado
tortoise
toss
total
tourist
toward
tower
town
toy
track
trade
traffic
tragic
train
transfer
trap
trash
travel
tray
treat
tree
trend
trial
tribe
trick
trigger
trim
trip
trophy
trouble
truck
true
truly
trumpet
trust
truth
try
tube
tuition
tumble
tuna
tunnel
turkey
turn
turtle
twelve
twenty
twice
twin
twist
two
type
typical
ugly
umbrella
unable
unaware
uncle
uncover
under
undo
unfair
unfold
unhappy
uniform
unique
unit
universe
unknown
unlock
until
unusual
unveil
update
upgrade
uphold
upon
upper
upset
urban
urge
usage
use
used
useful
useless
usual
utility
vacant
vacuum
vague
valid
valley
valve
van
vanish
vapor
various
vast
vault
vehicle
velvet
vendor
venture
venue
verb
verify
version
very
vessel
veteran
viable
vibrant
vicious
victory
video
view
village
vintage
violin
virtual
virus
visa
visit
visual
vital
vivid
vocal
voice
void
volcano
volume
vote
voyage
wage
wagon
wait
walk
wall
walnut
want
warfare
warm
warrior
wash
wasp
waste
water
wave
way
wealth
weapon
wear
weasel
weather
web
wedding
weekend
weird
welcome
west
wet
whale
what
wheat
wheel
when
where
whip
whisper
wide
width
wife
wild
will
win
window
wine
wing
wink
winner
winter
wire
wisdom
wise
wish
witness
wolf
woman
wonder
wood
wool
word
work
world
worry
worth
wrap
wreck
wrestle
wrist
write
wrong
yard
year
yellow
you
young
youth
zebra
zero
zone
zoo`.split("\n");

// node_modules/@scure/bip32/lib/esm/index.js
var Point2 = secp256k1.ProjectivePoint;
var base58check2 = createBase58check(sha256);
function bytesToNumber(bytes) {
  abytes(bytes);
  const h = bytes.length === 0 ? "0" : bytesToHex(bytes);
  return BigInt("0x" + h);
}
function numberToBytes(num2) {
  if (typeof num2 !== "bigint")
    throw new Error("bigint expected");
  return hexToBytes(num2.toString(16).padStart(64, "0"));
}
var MASTER_SECRET = utf8ToBytes("Bitcoin seed");
var BITCOIN_VERSIONS = { private: 76066276, public: 76067358 };
var HARDENED_OFFSET = 2147483648;
var hash160 = (data) => ripemd160(sha256(data));
var fromU32 = (data) => createView(data).getUint32(0, false);
var toU32 = (n) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 32 - 1) {
    throw new Error("invalid number, should be from 0 to 2**32-1, got " + n);
  }
  const buf = new Uint8Array(4);
  createView(buf).setUint32(0, n, false);
  return buf;
};
var HDKey = class _HDKey {
  get fingerprint() {
    if (!this.pubHash) {
      throw new Error("No publicKey set!");
    }
    return fromU32(this.pubHash);
  }
  get identifier() {
    return this.pubHash;
  }
  get pubKeyHash() {
    return this.pubHash;
  }
  get privateKey() {
    return this.privKeyBytes || null;
  }
  get publicKey() {
    return this.pubKey || null;
  }
  get privateExtendedKey() {
    const priv = this.privateKey;
    if (!priv) {
      throw new Error("No private key");
    }
    return base58check2.encode(this.serialize(this.versions.private, concatBytes(new Uint8Array([0]), priv)));
  }
  get publicExtendedKey() {
    if (!this.pubKey) {
      throw new Error("No public key");
    }
    return base58check2.encode(this.serialize(this.versions.public, this.pubKey));
  }
  static fromMasterSeed(seed, versions = BITCOIN_VERSIONS) {
    abytes(seed);
    if (8 * seed.length < 128 || 8 * seed.length > 512) {
      throw new Error("HDKey: seed length must be between 128 and 512 bits; 256 bits is advised, got " + seed.length);
    }
    const I = hmac(sha512, MASTER_SECRET, seed);
    return new _HDKey({
      versions,
      chainCode: I.slice(32),
      privateKey: I.slice(0, 32)
    });
  }
  static fromExtendedKey(base58key, versions = BITCOIN_VERSIONS) {
    const keyBuffer = base58check2.decode(base58key);
    const keyView = createView(keyBuffer);
    const version = keyView.getUint32(0, false);
    const opt = {
      versions,
      depth: keyBuffer[4],
      parentFingerprint: keyView.getUint32(5, false),
      index: keyView.getUint32(9, false),
      chainCode: keyBuffer.slice(13, 45)
    };
    const key = keyBuffer.slice(45);
    const isPriv = key[0] === 0;
    if (version !== versions[isPriv ? "private" : "public"]) {
      throw new Error("Version mismatch");
    }
    if (isPriv) {
      return new _HDKey({ ...opt, privateKey: key.slice(1) });
    } else {
      return new _HDKey({ ...opt, publicKey: key });
    }
  }
  static fromJSON(json) {
    return _HDKey.fromExtendedKey(json.xpriv);
  }
  constructor(opt) {
    this.depth = 0;
    this.index = 0;
    this.chainCode = null;
    this.parentFingerprint = 0;
    if (!opt || typeof opt !== "object") {
      throw new Error("HDKey.constructor must not be called directly");
    }
    this.versions = opt.versions || BITCOIN_VERSIONS;
    this.depth = opt.depth || 0;
    this.chainCode = opt.chainCode || null;
    this.index = opt.index || 0;
    this.parentFingerprint = opt.parentFingerprint || 0;
    if (!this.depth) {
      if (this.parentFingerprint || this.index) {
        throw new Error("HDKey: zero depth with non-zero index/parent fingerprint");
      }
    }
    if (opt.publicKey && opt.privateKey) {
      throw new Error("HDKey: publicKey and privateKey at same time.");
    }
    if (opt.privateKey) {
      if (!secp256k1.utils.isValidPrivateKey(opt.privateKey)) {
        throw new Error("Invalid private key");
      }
      this.privKey = typeof opt.privateKey === "bigint" ? opt.privateKey : bytesToNumber(opt.privateKey);
      this.privKeyBytes = numberToBytes(this.privKey);
      this.pubKey = secp256k1.getPublicKey(opt.privateKey, true);
    } else if (opt.publicKey) {
      this.pubKey = Point2.fromHex(opt.publicKey).toRawBytes(true);
    } else {
      throw new Error("HDKey: no public or private key provided");
    }
    this.pubHash = hash160(this.pubKey);
  }
  derive(path) {
    if (!/^[mM]'?/.test(path)) {
      throw new Error('Path must start with "m" or "M"');
    }
    if (/^[mM]'?$/.test(path)) {
      return this;
    }
    const parts = path.replace(/^[mM]'?\//, "").split("/");
    let child = this;
    for (const c of parts) {
      const m = /^(\d+)('?)$/.exec(c);
      const m1 = m && m[1];
      if (!m || m.length !== 3 || typeof m1 !== "string")
        throw new Error("invalid child index: " + c);
      let idx = +m1;
      if (!Number.isSafeInteger(idx) || idx >= HARDENED_OFFSET) {
        throw new Error("Invalid index");
      }
      if (m[2] === "'") {
        idx += HARDENED_OFFSET;
      }
      child = child.deriveChild(idx);
    }
    return child;
  }
  deriveChild(index) {
    if (!this.pubKey || !this.chainCode) {
      throw new Error("No publicKey or chainCode set");
    }
    let data = toU32(index);
    if (index >= HARDENED_OFFSET) {
      const priv = this.privateKey;
      if (!priv) {
        throw new Error("Could not derive hardened child key");
      }
      data = concatBytes(new Uint8Array([0]), priv, data);
    } else {
      data = concatBytes(this.pubKey, data);
    }
    const I = hmac(sha512, this.chainCode, data);
    const childTweak = bytesToNumber(I.slice(0, 32));
    const chainCode = I.slice(32);
    if (!secp256k1.utils.isValidPrivateKey(childTweak)) {
      throw new Error("Tweak bigger than curve order");
    }
    const opt = {
      versions: this.versions,
      chainCode,
      depth: this.depth + 1,
      parentFingerprint: this.fingerprint,
      index
    };
    try {
      if (this.privateKey) {
        const added = mod(this.privKey + childTweak, secp256k1.CURVE.n);
        if (!secp256k1.utils.isValidPrivateKey(added)) {
          throw new Error("The tweak was out of range or the resulted private key is invalid");
        }
        opt.privateKey = added;
      } else {
        const added = Point2.fromHex(this.pubKey).add(Point2.fromPrivateKey(childTweak));
        if (added.equals(Point2.ZERO)) {
          throw new Error("The tweak was equal to negative P, which made the result key invalid");
        }
        opt.publicKey = added.toRawBytes(true);
      }
      return new _HDKey(opt);
    } catch (err) {
      return this.deriveChild(index + 1);
    }
  }
  sign(hash) {
    if (!this.privateKey) {
      throw new Error("No privateKey set!");
    }
    abytes(hash, 32);
    return secp256k1.sign(hash, this.privKey).toCompactRawBytes();
  }
  verify(hash, signature) {
    abytes(hash, 32);
    abytes(signature, 64);
    if (!this.publicKey) {
      throw new Error("No publicKey set!");
    }
    let sig;
    try {
      sig = secp256k1.Signature.fromCompact(signature);
    } catch (error) {
      return false;
    }
    return secp256k1.verify(sig, hash, this.publicKey);
  }
  wipePrivateData() {
    this.privKey = void 0;
    if (this.privKeyBytes) {
      this.privKeyBytes.fill(0);
      this.privKeyBytes = void 0;
    }
    return this;
  }
  toJSON() {
    return {
      xpriv: this.privateExtendedKey,
      xpub: this.publicExtendedKey
    };
  }
  serialize(version, key) {
    if (!this.chainCode) {
      throw new Error("No chainCode set");
    }
    abytes(key, 33);
    return concatBytes(toU32(version), new Uint8Array([this.depth]), toU32(this.parentFingerprint), toU32(this.index), this.chainCode, key);
  }
};

// node_modules/@scure/btc-signer/esm/index.js
var esm_exports3 = {};
__export(esm_exports3, {
  Address: () => Address,
  CompactSize: () => CompactSize,
  DEFAULT_SEQUENCE: () => DEFAULT_SEQUENCE,
  Decimal: () => Decimal,
  MAX_SCRIPT_BYTE_LENGTH: () => MAX_SCRIPT_BYTE_LENGTH,
  NETWORK: () => NETWORK,
  OP: () => OP,
  OutScript: () => OutScript,
  PSBTCombine: () => PSBTCombine,
  RawTx: () => RawTx,
  RawWitness: () => RawWitness,
  Script: () => Script,
  ScriptNum: () => ScriptNum,
  SigHash: () => SigHash,
  TAPROOT_UNSPENDABLE_KEY: () => TAPROOT_UNSPENDABLE_KEY,
  TEST_NETWORK: () => TEST_NETWORK,
  TaprootControlBlock: () => TaprootControlBlock,
  Transaction: () => Transaction,
  WIF: () => WIF,
  _DebugPSBT: () => _DebugPSBT,
  _Estimator: () => _Estimator,
  _cmpBig: () => _cmpBig,
  _sortPubkeys: () => _sortPubkeys,
  bip32Path: () => bip32Path,
  combinations: () => combinations,
  getAddress: () => getAddress,
  getInputType: () => getInputType,
  multisig: () => multisig,
  p2ms: () => p2ms,
  p2pk: () => p2pk,
  p2pkh: () => p2pkh,
  p2sh: () => p2sh,
  p2tr: () => p2tr,
  p2tr_ms: () => p2tr_ms,
  p2tr_ns: () => p2tr_ns,
  p2tr_pk: () => p2tr_pk,
  p2wpkh: () => p2wpkh,
  p2wsh: () => p2wsh,
  selectUTXO: () => selectUTXO,
  sortedMultisig: () => sortedMultisig,
  taprootListToTree: () => taprootListToTree,
  utils: () => utils3
});

// node_modules/micro-packed/lib/esm/index.js
var EMPTY = /* @__PURE__ */ new Uint8Array();
var NULL = /* @__PURE__ */ new Uint8Array([0]);
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i])
      return false;
  return true;
}
function isBytes3(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function concatBytes2(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    if (!isBytes3(a))
      throw new Error("Uint8Array expected");
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
var createView2 = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
function isPlainObject(obj) {
  return Object.prototype.toString.call(obj) === "[object Object]";
}
function isNum(num2) {
  return Number.isSafeInteger(num2);
}
var utils2 = {
  equalBytes,
  isBytes: isBytes3,
  isCoder,
  checkBounds,
  concatBytes: concatBytes2,
  createView: createView2,
  isPlainObject
};
var lengthCoder = (len) => {
  if (len !== null && typeof len !== "string" && !isCoder(len) && !isBytes3(len) && !isNum(len)) {
    throw new Error(`lengthCoder: expected null | number | Uint8Array | CoderType, got ${len} (${typeof len})`);
  }
  return {
    encodeStream(w, value) {
      if (len === null)
        return;
      if (isCoder(len))
        return len.encodeStream(w, value);
      let byteLen;
      if (typeof len === "number")
        byteLen = len;
      else if (typeof len === "string")
        byteLen = Path.resolve(w.stack, len);
      if (typeof byteLen === "bigint")
        byteLen = Number(byteLen);
      if (byteLen === void 0 || byteLen !== value)
        throw w.err(`Wrong length: ${byteLen} len=${len} exp=${value} (${typeof value})`);
    },
    decodeStream(r) {
      let byteLen;
      if (isCoder(len))
        byteLen = Number(len.decodeStream(r));
      else if (typeof len === "number")
        byteLen = len;
      else if (typeof len === "string")
        byteLen = Path.resolve(r.stack, len);
      if (typeof byteLen === "bigint")
        byteLen = Number(byteLen);
      if (typeof byteLen !== "number")
        throw r.err(`Wrong length: ${byteLen}`);
      return byteLen;
    }
  };
};
var Bitset = {
  BITS: 32,
  FULL_MASK: -1 >>> 0,
  // 1<<32 will overflow
  len: (len) => Math.ceil(len / 32),
  create: (len) => new Uint32Array(Bitset.len(len)),
  clean: (bs) => bs.fill(0),
  debug: (bs) => Array.from(bs).map((i) => (i >>> 0).toString(2).padStart(32, "0")),
  checkLen: (bs, len) => {
    if (Bitset.len(len) === bs.length)
      return;
    throw new Error(`wrong length=${bs.length}. Expected: ${Bitset.len(len)}`);
  },
  chunkLen: (bsLen, pos, len) => {
    if (pos < 0)
      throw new Error(`wrong pos=${pos}`);
    if (pos + len > bsLen)
      throw new Error(`wrong range=${pos}/${len} of ${bsLen}`);
  },
  set: (bs, chunk, value, allowRewrite = true) => {
    if (!allowRewrite && (bs[chunk] & value) !== 0)
      return false;
    bs[chunk] |= value;
    return true;
  },
  pos: (pos, i) => ({
    chunk: Math.floor((pos + i) / 32),
    mask: 1 << 32 - (pos + i) % 32 - 1
  }),
  indices: (bs, len, invert2 = false) => {
    Bitset.checkLen(bs, len);
    const { FULL_MASK, BITS } = Bitset;
    const left = BITS - len % BITS;
    const lastMask = left ? FULL_MASK >>> left << left : FULL_MASK;
    const res = [];
    for (let i = 0; i < bs.length; i++) {
      let c = bs[i];
      if (invert2)
        c = ~c;
      if (i === bs.length - 1)
        c &= lastMask;
      if (c === 0)
        continue;
      for (let j = 0; j < BITS; j++) {
        const m = 1 << BITS - j - 1;
        if (c & m)
          res.push(i * BITS + j);
      }
    }
    return res;
  },
  range: (arr) => {
    const res = [];
    let cur;
    for (const i of arr) {
      if (cur === void 0 || i !== cur.pos + cur.length)
        res.push(cur = { pos: i, length: 1 });
      else
        cur.length += 1;
    }
    return res;
  },
  rangeDebug: (bs, len, invert2 = false) => `[${Bitset.range(Bitset.indices(bs, len, invert2)).map((i) => `(${i.pos}/${i.length})`).join(", ")}]`,
  setRange: (bs, bsLen, pos, len, allowRewrite = true) => {
    Bitset.chunkLen(bsLen, pos, len);
    const { FULL_MASK, BITS } = Bitset;
    const first = pos % BITS ? Math.floor(pos / BITS) : void 0;
    const lastPos = pos + len;
    const last = lastPos % BITS ? Math.floor(lastPos / BITS) : void 0;
    if (first !== void 0 && first === last)
      return Bitset.set(bs, first, FULL_MASK >>> BITS - len << BITS - len - pos, allowRewrite);
    if (first !== void 0) {
      if (!Bitset.set(bs, first, FULL_MASK >>> pos % BITS, allowRewrite))
        return false;
    }
    const start = first !== void 0 ? first + 1 : pos / BITS;
    const end = last !== void 0 ? last : lastPos / BITS;
    for (let i = start; i < end; i++)
      if (!Bitset.set(bs, i, FULL_MASK, allowRewrite))
        return false;
    if (last !== void 0 && first !== last) {
      if (!Bitset.set(bs, last, FULL_MASK << BITS - lastPos % BITS, allowRewrite))
        return false;
    }
    return true;
  }
};
var Path = {
  /**
   * Internal method for handling stack of paths (debug, errors, dynamic fields via path)
   * This is looks ugly (callback), but allows us to force stack cleaning by construction (.pop always after function).
   * Also, this makes impossible:
   * - pushing field when stack is empty
   * - pushing field inside of field (real bug)
   * NOTE: we don't want to do '.pop' on error!
   */
  pushObj: (stack, obj, objFn) => {
    const last = { obj };
    stack.push(last);
    objFn((field, fieldFn) => {
      last.field = field;
      fieldFn();
      last.field = void 0;
    });
    stack.pop();
  },
  path: (stack) => {
    const res = [];
    for (const i of stack)
      if (i.field !== void 0)
        res.push(i.field);
    return res.join("/");
  },
  err: (name, stack, msg) => {
    const err = new Error(`${name}(${Path.path(stack)}): ${typeof msg === "string" ? msg : msg.message}`);
    if (msg instanceof Error && msg.stack)
      err.stack = msg.stack;
    return err;
  },
  resolve: (stack, path) => {
    const parts = path.split("/");
    const objPath = stack.map((i2) => i2.obj);
    let i = 0;
    for (; i < parts.length; i++) {
      if (parts[i] === "..")
        objPath.pop();
      else
        break;
    }
    let cur = objPath.pop();
    for (; i < parts.length; i++) {
      if (!cur || cur[parts[i]] === void 0)
        return void 0;
      cur = cur[parts[i]];
    }
    return cur;
  }
};
var _Reader = class __Reader {
  constructor(data, opts = {}, stack = [], parent = void 0, parentOffset = 0) {
    this.pos = 0;
    this.bitBuf = 0;
    this.bitPos = 0;
    this.data = data;
    this.opts = opts;
    this.stack = stack;
    this.parent = parent;
    this.parentOffset = parentOffset;
    this.view = createView2(data);
  }
  /** Internal method for pointers. */
  _enablePointers() {
    if (this.parent)
      return this.parent._enablePointers();
    if (this.bs)
      return;
    this.bs = Bitset.create(this.data.length);
    Bitset.setRange(this.bs, this.data.length, 0, this.pos, this.opts.allowMultipleReads);
  }
  markBytesBS(pos, len) {
    if (this.parent)
      return this.parent.markBytesBS(this.parentOffset + pos, len);
    if (!len)
      return true;
    if (!this.bs)
      return true;
    return Bitset.setRange(this.bs, this.data.length, pos, len, false);
  }
  markBytes(len) {
    const pos = this.pos;
    this.pos += len;
    const res = this.markBytesBS(pos, len);
    if (!this.opts.allowMultipleReads && !res)
      throw this.err(`multiple read pos=${this.pos} len=${len}`);
    return res;
  }
  pushObj(obj, objFn) {
    return Path.pushObj(this.stack, obj, objFn);
  }
  readView(n, fn) {
    if (!Number.isFinite(n))
      throw this.err(`readView: wrong length=${n}`);
    if (this.pos + n > this.data.length)
      throw this.err("readView: Unexpected end of buffer");
    const res = fn(this.view, this.pos);
    this.markBytes(n);
    return res;
  }
  // read bytes by absolute offset
  absBytes(n) {
    if (n > this.data.length)
      throw new Error("Unexpected end of buffer");
    return this.data.subarray(n);
  }
  finish() {
    if (this.opts.allowUnreadBytes)
      return;
    if (this.bitPos) {
      throw this.err(`${this.bitPos} bits left after unpack: ${hex.encode(this.data.slice(this.pos))}`);
    }
    if (this.bs && !this.parent) {
      const notRead = Bitset.indices(this.bs, this.data.length, true);
      if (notRead.length) {
        const formatted = Bitset.range(notRead).map(({ pos, length }) => `(${pos}/${length})[${hex.encode(this.data.subarray(pos, pos + length))}]`).join(", ");
        throw this.err(`unread byte ranges: ${formatted} (total=${this.data.length})`);
      } else
        return;
    }
    if (!this.isEnd()) {
      throw this.err(`${this.leftBytes} bytes ${this.bitPos} bits left after unpack: ${hex.encode(this.data.slice(this.pos))}`);
    }
  }
  // User methods
  err(msg) {
    return Path.err("Reader", this.stack, msg);
  }
  offsetReader(n) {
    if (n > this.data.length)
      throw this.err("offsetReader: Unexpected end of buffer");
    return new __Reader(this.absBytes(n), this.opts, this.stack, this, n);
  }
  bytes(n, peek = false) {
    if (this.bitPos)
      throw this.err("readBytes: bitPos not empty");
    if (!Number.isFinite(n))
      throw this.err(`readBytes: wrong length=${n}`);
    if (this.pos + n > this.data.length)
      throw this.err("readBytes: Unexpected end of buffer");
    const slice = this.data.subarray(this.pos, this.pos + n);
    if (!peek)
      this.markBytes(n);
    return slice;
  }
  byte(peek = false) {
    if (this.bitPos)
      throw this.err("readByte: bitPos not empty");
    if (this.pos + 1 > this.data.length)
      throw this.err("readBytes: Unexpected end of buffer");
    const data = this.data[this.pos];
    if (!peek)
      this.markBytes(1);
    return data;
  }
  get leftBytes() {
    return this.data.length - this.pos;
  }
  get totalBytes() {
    return this.data.length;
  }
  isEnd() {
    return this.pos >= this.data.length && !this.bitPos;
  }
  // bits are read in BE mode (left to right): (0b1000_0000).readBits(1) == 1
  bits(bits) {
    if (bits > 32)
      throw this.err("BitReader: cannot read more than 32 bits in single call");
    let out = 0;
    while (bits) {
      if (!this.bitPos) {
        this.bitBuf = this.byte();
        this.bitPos = 8;
      }
      const take = Math.min(bits, this.bitPos);
      this.bitPos -= take;
      out = out << take | this.bitBuf >> this.bitPos & 2 ** take - 1;
      this.bitBuf &= 2 ** this.bitPos - 1;
      bits -= take;
    }
    return out >>> 0;
  }
  find(needle, pos = this.pos) {
    if (!isBytes3(needle))
      throw this.err(`find: needle is not bytes! ${needle}`);
    if (this.bitPos)
      throw this.err("findByte: bitPos not empty");
    if (!needle.length)
      throw this.err(`find: needle is empty`);
    for (let idx = pos; (idx = this.data.indexOf(needle[0], idx)) !== -1; idx++) {
      if (idx === -1)
        return;
      const leftBytes = this.data.length - idx;
      if (leftBytes < needle.length)
        return;
      if (equalBytes(needle, this.data.subarray(idx, idx + needle.length)))
        return idx;
    }
    return;
  }
};
var _Writer = class {
  constructor(stack = []) {
    this.pos = 0;
    this.buffers = [];
    this.ptrs = [];
    this.bitBuf = 0;
    this.bitPos = 0;
    this.viewBuf = new Uint8Array(8);
    this.finished = false;
    this.stack = stack;
    this.view = createView2(this.viewBuf);
  }
  pushObj(obj, objFn) {
    return Path.pushObj(this.stack, obj, objFn);
  }
  writeView(len, fn) {
    if (this.finished)
      throw this.err("buffer: finished");
    if (!isNum(len) || len > 8)
      throw new Error(`wrong writeView length=${len}`);
    fn(this.view);
    this.bytes(this.viewBuf.slice(0, len));
    this.viewBuf.fill(0);
  }
  // User methods
  err(msg) {
    if (this.finished)
      throw this.err("buffer: finished");
    return Path.err("Reader", this.stack, msg);
  }
  bytes(b) {
    if (this.finished)
      throw this.err("buffer: finished");
    if (this.bitPos)
      throw this.err("writeBytes: ends with non-empty bit buffer");
    this.buffers.push(b);
    this.pos += b.length;
  }
  byte(b) {
    if (this.finished)
      throw this.err("buffer: finished");
    if (this.bitPos)
      throw this.err("writeByte: ends with non-empty bit buffer");
    this.buffers.push(new Uint8Array([b]));
    this.pos++;
  }
  finish(clean2 = true) {
    if (this.finished)
      throw this.err("buffer: finished");
    if (this.bitPos)
      throw this.err("buffer: ends with non-empty bit buffer");
    const buffers = this.buffers.concat(this.ptrs.map((i) => i.buffer));
    const sum = buffers.map((b) => b.length).reduce((a, b) => a + b, 0);
    const buf = new Uint8Array(sum);
    for (let i = 0, pad = 0; i < buffers.length; i++) {
      const a = buffers[i];
      buf.set(a, pad);
      pad += a.length;
    }
    for (let pos = this.pos, i = 0; i < this.ptrs.length; i++) {
      const ptr = this.ptrs[i];
      buf.set(ptr.ptr.encode(pos), ptr.pos);
      pos += ptr.buffer.length;
    }
    if (clean2) {
      this.buffers = [];
      for (const p of this.ptrs)
        p.buffer.fill(0);
      this.ptrs = [];
      this.finished = true;
      this.bitBuf = 0;
    }
    return buf;
  }
  bits(value, bits) {
    if (bits > 32)
      throw this.err("writeBits: cannot write more than 32 bits in single call");
    if (value >= 2 ** bits)
      throw this.err(`writeBits: value (${value}) >= 2**bits (${bits})`);
    while (bits) {
      const take = Math.min(bits, 8 - this.bitPos);
      this.bitBuf = this.bitBuf << take | value >> bits - take;
      this.bitPos += take;
      bits -= take;
      value &= 2 ** bits - 1;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.buffers.push(new Uint8Array([this.bitBuf]));
        this.pos++;
      }
    }
  }
};
var swapEndianness = (b) => Uint8Array.from(b).reverse();
function checkBounds(value, bits, signed) {
  if (signed) {
    const signBit = 2n ** (bits - 1n);
    if (value < -signBit || value >= signBit)
      throw new Error(`value out of signed bounds. Expected ${-signBit} <= ${value} < ${signBit}`);
  } else {
    if (0n > value || value >= 2n ** bits)
      throw new Error(`value out of unsigned bounds. Expected 0 <= ${value} < ${2n ** bits}`);
  }
}
function _wrap(inner) {
  return {
    // NOTE: we cannot export validate here, since it is likely mistake.
    encodeStream: inner.encodeStream,
    decodeStream: inner.decodeStream,
    size: inner.size,
    encode: (value) => {
      const w = new _Writer();
      inner.encodeStream(w, value);
      return w.finish();
    },
    decode: (data, opts = {}) => {
      const r = new _Reader(data, opts);
      const res = inner.decodeStream(r);
      r.finish();
      return res;
    }
  };
}
function validate(inner, fn) {
  if (!isCoder(inner))
    throw new Error(`validate: invalid inner value ${inner}`);
  if (typeof fn !== "function")
    throw new Error("validate: fn should be function");
  return _wrap({
    size: inner.size,
    encodeStream: (w, value) => {
      let res;
      try {
        res = fn(value);
      } catch (e) {
        throw w.err(e);
      }
      inner.encodeStream(w, res);
    },
    decodeStream: (r) => {
      const res = inner.decodeStream(r);
      try {
        return fn(res);
      } catch (e) {
        throw r.err(e);
      }
    }
  });
}
var wrap = (inner) => {
  const res = _wrap(inner);
  return inner.validate ? validate(res, inner.validate) : res;
};
var isBaseCoder = (elm) => isPlainObject(elm) && typeof elm.decode === "function" && typeof elm.encode === "function";
function isCoder(elm) {
  return isPlainObject(elm) && isBaseCoder(elm) && typeof elm.encodeStream === "function" && typeof elm.decodeStream === "function" && (elm.size === void 0 || isNum(elm.size));
}
function dict() {
  return {
    encode: (from) => {
      if (!Array.isArray(from))
        throw new Error("array expected");
      const to = {};
      for (const item of from) {
        if (!Array.isArray(item) || item.length !== 2)
          throw new Error(`array of two elements expected`);
        const name = item[0];
        const value = item[1];
        if (to[name] !== void 0)
          throw new Error(`key(${name}) appears twice in struct`);
        to[name] = value;
      }
      return to;
    },
    decode: (to) => {
      if (!isPlainObject(to))
        throw new Error(`expected plain object, got ${to}`);
      return Object.entries(to);
    }
  };
}
var numberBigint = {
  encode: (from) => {
    if (typeof from !== "bigint")
      throw new Error(`expected bigint, got ${typeof from}`);
    if (from > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(`element bigger than MAX_SAFE_INTEGER=${from}`);
    return Number(from);
  },
  decode: (to) => {
    if (!isNum(to))
      throw new Error("element is not a safe integer");
    return BigInt(to);
  }
};
function tsEnum(e) {
  if (!isPlainObject(e))
    throw new Error("plain object expected");
  return {
    encode: (from) => {
      if (!isNum(from) || !(from in e))
        throw new Error(`wrong value ${from}`);
      return e[from];
    },
    decode: (to) => {
      if (typeof to !== "string")
        throw new Error(`wrong value ${typeof to}`);
      return e[to];
    }
  };
}
function decimal(precision, round = false) {
  if (!isNum(precision))
    throw new Error(`decimal/precision: wrong value ${precision}`);
  if (typeof round !== "boolean")
    throw new Error(`decimal/round: expected boolean, got ${typeof round}`);
  const decimalMask = 10n ** BigInt(precision);
  return {
    encode: (from) => {
      if (typeof from !== "bigint")
        throw new Error(`expected bigint, got ${typeof from}`);
      let s = (from < 0n ? -from : from).toString(10);
      let sep = s.length - precision;
      if (sep < 0) {
        s = s.padStart(s.length - sep, "0");
        sep = 0;
      }
      let i = s.length - 1;
      for (; i >= sep && s[i] === "0"; i--)
        ;
      let int = s.slice(0, sep);
      let frac = s.slice(sep, i + 1);
      if (!int)
        int = "0";
      if (from < 0n)
        int = "-" + int;
      if (!frac)
        return int;
      return `${int}.${frac}`;
    },
    decode: (to) => {
      if (typeof to !== "string")
        throw new Error(`expected string, got ${typeof to}`);
      if (to === "-0")
        throw new Error(`negative zero is not allowed`);
      let neg = false;
      if (to.startsWith("-")) {
        neg = true;
        to = to.slice(1);
      }
      if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(to))
        throw new Error(`wrong string value=${to}`);
      let sep = to.indexOf(".");
      sep = sep === -1 ? to.length : sep;
      const intS = to.slice(0, sep);
      const fracS = to.slice(sep + 1).replace(/0+$/, "");
      const int = BigInt(intS) * decimalMask;
      if (!round && fracS.length > precision) {
        throw new Error(`fractional part cannot be represented with this precision (num=${to}, prec=${precision})`);
      }
      const fracLen = Math.min(fracS.length, precision);
      const frac = BigInt(fracS.slice(0, fracLen)) * 10n ** BigInt(precision - fracLen);
      const value = int + frac;
      return neg ? -value : value;
    }
  };
}
function match(lst) {
  if (!Array.isArray(lst))
    throw new Error(`expected array, got ${typeof lst}`);
  for (const i of lst)
    if (!isBaseCoder(i))
      throw new Error(`wrong base coder ${i}`);
  return {
    encode: (from) => {
      for (const c of lst) {
        const elm = c.encode(from);
        if (elm !== void 0)
          return elm;
      }
      throw new Error(`match/encode: cannot find match in ${from}`);
    },
    decode: (to) => {
      for (const c of lst) {
        const elm = c.decode(to);
        if (elm !== void 0)
          return elm;
      }
      throw new Error(`match/decode: cannot find match in ${to}`);
    }
  };
}
var reverse = (coder) => {
  if (!isBaseCoder(coder))
    throw new Error("BaseCoder expected");
  return { encode: coder.decode, decode: coder.encode };
};
var coders = { dict, numberBigint, tsEnum, decimal, match, reverse };
var bigint = (size, le = false, signed = false, sized = true) => {
  if (!isNum(size))
    throw new Error(`bigint/size: wrong value ${size}`);
  if (typeof le !== "boolean")
    throw new Error(`bigint/le: expected boolean, got ${typeof le}`);
  if (typeof signed !== "boolean")
    throw new Error(`bigint/signed: expected boolean, got ${typeof signed}`);
  if (typeof sized !== "boolean")
    throw new Error(`bigint/sized: expected boolean, got ${typeof sized}`);
  const bLen = BigInt(size);
  const signBit = 2n ** (8n * bLen - 1n);
  return wrap({
    size: sized ? size : void 0,
    encodeStream: (w, value) => {
      if (signed && value < 0)
        value = value | signBit;
      const b = [];
      for (let i = 0; i < size; i++) {
        b.push(Number(value & 255n));
        value >>= 8n;
      }
      let res = new Uint8Array(b).reverse();
      if (!sized) {
        let pos = 0;
        for (pos = 0; pos < res.length; pos++)
          if (res[pos] !== 0)
            break;
        res = res.subarray(pos);
      }
      w.bytes(le ? res.reverse() : res);
    },
    decodeStream: (r) => {
      const value = r.bytes(sized ? size : Math.min(size, r.leftBytes));
      const b = le ? value : swapEndianness(value);
      let res = 0n;
      for (let i = 0; i < b.length; i++)
        res |= BigInt(b[i]) << 8n * BigInt(i);
      if (signed && res & signBit)
        res = (res ^ signBit) - signBit;
      return res;
    },
    validate: (value) => {
      if (typeof value !== "bigint")
        throw new Error(`bigint: invalid value: ${value}`);
      checkBounds(value, 8n * bLen, !!signed);
      return value;
    }
  });
};
var U256BE = /* @__PURE__ */ bigint(32, false);
var U64LE = /* @__PURE__ */ bigint(8, true);
var I64LE = /* @__PURE__ */ bigint(8, true, true);
var view = (len, opts) => wrap({
  size: len,
  encodeStream: (w, value) => w.writeView(len, (view2) => opts.write(view2, value)),
  decodeStream: (r) => r.readView(len, opts.read),
  validate: (value) => {
    if (typeof value !== "number")
      throw new Error(`viewCoder: expected number, got ${typeof value}`);
    if (opts.validate)
      opts.validate(value);
    return value;
  }
});
var intView = (len, signed, opts) => {
  const bits = len * 8;
  const signBit = 2 ** (bits - 1);
  const validateSigned = (value) => {
    if (!isNum(value))
      throw new Error(`sintView: value is not safe integer: ${value}`);
    if (value < -signBit || value >= signBit) {
      throw new Error(`sintView: value out of bounds. Expected ${-signBit} <= ${value} < ${signBit}`);
    }
  };
  const maxVal = 2 ** bits;
  const validateUnsigned = (value) => {
    if (!isNum(value))
      throw new Error(`uintView: value is not safe integer: ${value}`);
    if (0 > value || value >= maxVal) {
      throw new Error(`uintView: value out of bounds. Expected 0 <= ${value} < ${maxVal}`);
    }
  };
  return view(len, {
    write: opts.write,
    read: opts.read,
    validate: signed ? validateSigned : validateUnsigned
  });
};
var U32LE = /* @__PURE__ */ intView(4, false, {
  read: (view2, pos) => view2.getUint32(pos, true),
  write: (view2, value) => view2.setUint32(0, value, true)
});
var U32BE = /* @__PURE__ */ intView(4, false, {
  read: (view2, pos) => view2.getUint32(pos, false),
  write: (view2, value) => view2.setUint32(0, value, false)
});
var I32LE = /* @__PURE__ */ intView(4, true, {
  read: (view2, pos) => view2.getInt32(pos, true),
  write: (view2, value) => view2.setInt32(0, value, true)
});
var U16LE = /* @__PURE__ */ intView(2, false, {
  read: (view2, pos) => view2.getUint16(pos, true),
  write: (view2, value) => view2.setUint16(0, value, true)
});
var U8 = /* @__PURE__ */ intView(1, false, {
  read: (view2, pos) => view2.getUint8(pos),
  write: (view2, value) => view2.setUint8(0, value)
});
var createBytes = (len, le = false) => {
  if (typeof le !== "boolean")
    throw new Error(`bytes/le: expected boolean, got ${typeof le}`);
  const _length = lengthCoder(len);
  const _isb = isBytes3(len);
  return wrap({
    size: typeof len === "number" ? len : void 0,
    encodeStream: (w, value) => {
      if (!_isb)
        _length.encodeStream(w, value.length);
      w.bytes(le ? swapEndianness(value) : value);
      if (_isb)
        w.bytes(len);
    },
    decodeStream: (r) => {
      let bytes;
      if (_isb) {
        const tPos = r.find(len);
        if (!tPos)
          throw r.err(`bytes: cannot find terminator`);
        bytes = r.bytes(tPos - r.pos);
        r.bytes(len.length);
      } else {
        bytes = r.bytes(len === null ? r.leftBytes : _length.decodeStream(r));
      }
      return le ? swapEndianness(bytes) : bytes;
    },
    validate: (value) => {
      if (!isBytes3(value))
        throw new Error(`bytes: invalid value ${value}`);
      return value;
    }
  });
};
function prefix(len, inner) {
  if (!isCoder(inner))
    throw new Error(`prefix: invalid inner value ${inner}`);
  return apply(createBytes(len), reverse(inner));
}
var string = (len, le = false) => validate(apply(createBytes(len, le), utf8), (value) => {
  if (typeof value !== "string")
    throw new Error(`expected string, got ${typeof value}`);
  return value;
});
var createHex = (len, options = { isLE: false, with0x: false }) => {
  let inner = apply(createBytes(len, options.isLE), hex);
  const prefix2 = options.with0x;
  if (typeof prefix2 !== "boolean")
    throw new Error(`hex/with0x: expected boolean, got ${typeof prefix2}`);
  if (prefix2) {
    inner = apply(inner, {
      encode: (value) => `0x${value}`,
      decode: (value) => {
        if (!value.startsWith("0x"))
          throw new Error("hex(with0x=true).encode input should start with 0x");
        return value.slice(2);
      }
    });
  }
  return inner;
};
function apply(inner, base) {
  if (!isCoder(inner))
    throw new Error(`apply: invalid inner value ${inner}`);
  if (!isBaseCoder(base))
    throw new Error(`apply: invalid base value ${inner}`);
  return wrap({
    size: inner.size,
    encodeStream: (w, value) => {
      let innerValue;
      try {
        innerValue = base.decode(value);
      } catch (e) {
        throw w.err("" + e);
      }
      return inner.encodeStream(w, innerValue);
    },
    decodeStream: (r) => {
      const innerValue = inner.decodeStream(r);
      try {
        return base.encode(innerValue);
      } catch (e) {
        throw r.err("" + e);
      }
    }
  });
}
var flag = (flagValue, xor = false) => {
  if (!isBytes3(flagValue))
    throw new Error(`flag/flagValue: expected Uint8Array, got ${typeof flagValue}`);
  if (typeof xor !== "boolean")
    throw new Error(`flag/xor: expected boolean, got ${typeof xor}`);
  return wrap({
    size: flagValue.length,
    encodeStream: (w, value) => {
      if (!!value !== xor)
        w.bytes(flagValue);
    },
    decodeStream: (r) => {
      let hasFlag = r.leftBytes >= flagValue.length;
      if (hasFlag) {
        hasFlag = equalBytes(r.bytes(flagValue.length, true), flagValue);
        if (hasFlag)
          r.bytes(flagValue.length);
      }
      return hasFlag !== xor;
    },
    validate: (value) => {
      if (value !== void 0 && typeof value !== "boolean")
        throw new Error(`flag: expected boolean value or undefined, got ${typeof value}`);
      return value;
    }
  });
};
function flagged(path, inner, def2) {
  if (!isCoder(inner))
    throw new Error(`flagged: invalid inner value ${inner}`);
  if (typeof path !== "string" && !isCoder(inner))
    throw new Error(`flagged: wrong path=${path}`);
  return wrap({
    encodeStream: (w, value) => {
      if (typeof path === "string") {
        if (Path.resolve(w.stack, path))
          inner.encodeStream(w, value);
        else if (def2)
          inner.encodeStream(w, def2);
      } else {
        path.encodeStream(w, !!value);
        if (!!value)
          inner.encodeStream(w, value);
        else if (def2)
          inner.encodeStream(w, def2);
      }
    },
    decodeStream: (r) => {
      let hasFlag = false;
      if (typeof path === "string")
        hasFlag = !!Path.resolve(r.stack, path);
      else
        hasFlag = path.decodeStream(r);
      if (hasFlag)
        return inner.decodeStream(r);
      else if (def2)
        inner.decodeStream(r);
      return;
    }
  });
}
function magic(inner, constant, check = true) {
  if (!isCoder(inner))
    throw new Error(`magic: invalid inner value ${inner}`);
  if (typeof check !== "boolean")
    throw new Error(`magic: expected boolean, got ${typeof check}`);
  return wrap({
    size: inner.size,
    encodeStream: (w, _value) => inner.encodeStream(w, constant),
    decodeStream: (r) => {
      const value = inner.decodeStream(r);
      if (check && typeof value !== "object" && value !== constant || isBytes3(constant) && !equalBytes(constant, value)) {
        throw r.err(`magic: invalid value: ${value} !== ${constant}`);
      }
      return;
    },
    validate: (value) => {
      if (value !== void 0)
        throw new Error(`magic: wrong value=${typeof value}`);
      return value;
    }
  });
}
function sizeof(fields) {
  let size = 0;
  for (const f of fields) {
    if (f.size === void 0)
      return;
    if (!isNum(f.size))
      throw new Error(`sizeof: wrong element size=${size}`);
    size += f.size;
  }
  return size;
}
function struct(fields) {
  if (!isPlainObject(fields))
    throw new Error(`struct: expected plain object, got ${fields}`);
  for (const name in fields) {
    if (!isCoder(fields[name]))
      throw new Error(`struct: field ${name} is not CoderType`);
  }
  return wrap({
    size: sizeof(Object.values(fields)),
    encodeStream: (w, value) => {
      w.pushObj(value, (fieldFn) => {
        for (const name in fields)
          fieldFn(name, () => fields[name].encodeStream(w, value[name]));
      });
    },
    decodeStream: (r) => {
      const res = {};
      r.pushObj(res, (fieldFn) => {
        for (const name in fields)
          fieldFn(name, () => res[name] = fields[name].decodeStream(r));
      });
      return res;
    },
    validate: (value) => {
      if (typeof value !== "object" || value === null)
        throw new Error(`struct: invalid value ${value}`);
      return value;
    }
  });
}
function tuple(fields) {
  if (!Array.isArray(fields))
    throw new Error(`Packed.Tuple: got ${typeof fields} instead of array`);
  for (let i = 0; i < fields.length; i++) {
    if (!isCoder(fields[i]))
      throw new Error(`tuple: field ${i} is not CoderType`);
  }
  return wrap({
    size: sizeof(fields),
    encodeStream: (w, value) => {
      if (!Array.isArray(value))
        throw w.err(`tuple: invalid value ${value}`);
      w.pushObj(value, (fieldFn) => {
        for (let i = 0; i < fields.length; i++)
          fieldFn(`${i}`, () => fields[i].encodeStream(w, value[i]));
      });
    },
    decodeStream: (r) => {
      const res = [];
      r.pushObj(res, (fieldFn) => {
        for (let i = 0; i < fields.length; i++)
          fieldFn(`${i}`, () => res.push(fields[i].decodeStream(r)));
      });
      return res;
    },
    validate: (value) => {
      if (!Array.isArray(value))
        throw new Error(`tuple: invalid value ${value}`);
      if (value.length !== fields.length)
        throw new Error(`tuple: wrong length=${value.length}, expected ${fields.length}`);
      return value;
    }
  });
}
function array(len, inner) {
  if (!isCoder(inner))
    throw new Error(`array: invalid inner value ${inner}`);
  const _length = lengthCoder(typeof len === "string" ? `../${len}` : len);
  return wrap({
    size: typeof len === "number" && inner.size ? len * inner.size : void 0,
    encodeStream: (w, value) => {
      const _w = w;
      _w.pushObj(value, (fieldFn) => {
        if (!isBytes3(len))
          _length.encodeStream(w, value.length);
        for (let i = 0; i < value.length; i++) {
          fieldFn(`${i}`, () => {
            const elm = value[i];
            const startPos = w.pos;
            inner.encodeStream(w, elm);
            if (isBytes3(len)) {
              if (len.length > _w.pos - startPos)
                return;
              const data = _w.finish(false).subarray(startPos, _w.pos);
              if (equalBytes(data.subarray(0, len.length), len))
                throw _w.err(`array: inner element encoding same as separator. elm=${elm} data=${data}`);
            }
          });
        }
      });
      if (isBytes3(len))
        w.bytes(len);
    },
    decodeStream: (r) => {
      const res = [];
      r.pushObj(res, (fieldFn) => {
        if (len === null) {
          for (let i = 0; !r.isEnd(); i++) {
            fieldFn(`${i}`, () => res.push(inner.decodeStream(r)));
            if (inner.size && r.leftBytes < inner.size)
              break;
          }
        } else if (isBytes3(len)) {
          for (let i = 0; ; i++) {
            if (equalBytes(r.bytes(len.length, true), len)) {
              r.bytes(len.length);
              break;
            }
            fieldFn(`${i}`, () => res.push(inner.decodeStream(r)));
          }
        } else {
          let length;
          fieldFn("arrayLen", () => length = _length.decodeStream(r));
          for (let i = 0; i < length; i++)
            fieldFn(`${i}`, () => res.push(inner.decodeStream(r)));
        }
      });
      return res;
    },
    validate: (value) => {
      if (!Array.isArray(value))
        throw new Error(`array: invalid value ${value}`);
      return value;
    }
  });
}

// node_modules/@scure/btc-signer/esm/utils.js
var Point3 = secp256k1.ProjectivePoint;
var CURVE_ORDER = secp256k1.CURVE.n;
var isBytes4 = utils2.isBytes;
var concatBytes3 = utils2.concatBytes;
var equalBytes2 = utils2.equalBytes;
var hash1602 = (msg) => ripemd160(sha256(msg));
var sha256x2 = (...msgs) => sha256(sha256(concatBytes3(...msgs)));
var randomPrivateKeyBytes = schnorr.utils.randomPrivateKey;
var pubSchnorr = schnorr.getPublicKey;
var pubECDSA = secp256k1.getPublicKey;
var hasLowR = (sig) => sig.r < CURVE_ORDER / 2n;
function signECDSA(hash, privateKey, lowR = false) {
  let sig = secp256k1.sign(hash, privateKey);
  if (lowR && !hasLowR(sig)) {
    const extraEntropy = new Uint8Array(32);
    let counter = 0;
    while (!hasLowR(sig)) {
      extraEntropy.set(U32LE.encode(counter++));
      sig = secp256k1.sign(hash, privateKey, { extraEntropy });
      if (counter > 4294967295)
        throw new Error("lowR counter overflow: report the error");
    }
  }
  return sig.toDERRawBytes();
}
var signSchnorr = schnorr.sign;
var tagSchnorr = schnorr.utils.taggedHash;
var PubT;
(function(PubT2) {
  PubT2[PubT2["ecdsa"] = 0] = "ecdsa";
  PubT2[PubT2["schnorr"] = 1] = "schnorr";
})(PubT || (PubT = {}));
function validatePubkey(pub, type) {
  const len = pub.length;
  if (type === PubT.ecdsa) {
    if (len === 32)
      throw new Error("Expected non-Schnorr key");
    Point3.fromHex(pub);
    return pub;
  } else if (type === PubT.schnorr) {
    if (len !== 32)
      throw new Error("Expected 32-byte Schnorr key");
    schnorr.utils.lift_x(schnorr.utils.bytesToNumberBE(pub));
    return pub;
  } else {
    throw new Error("Unknown key type");
  }
}
function tapTweak(a, b) {
  const u = schnorr.utils;
  const t = u.taggedHash("TapTweak", a, b);
  const tn = u.bytesToNumberBE(t);
  if (tn >= CURVE_ORDER)
    throw new Error("tweak higher than curve order");
  return tn;
}
function taprootTweakPrivKey(privKey, merkleRoot = Uint8Array.of()) {
  const u = schnorr.utils;
  const seckey0 = u.bytesToNumberBE(privKey);
  const P2 = Point3.fromPrivateKey(seckey0);
  const seckey = P2.hasEvenY() ? seckey0 : u.mod(-seckey0, CURVE_ORDER);
  const xP = u.pointToBytes(P2);
  const t = tapTweak(xP, merkleRoot);
  return u.numberToBytesBE(u.mod(seckey + t, CURVE_ORDER), 32);
}
function taprootTweakPubkey(pubKey, h) {
  const u = schnorr.utils;
  const t = tapTweak(pubKey, h);
  const P2 = u.lift_x(u.bytesToNumberBE(pubKey));
  const Q = P2.add(Point3.fromPrivateKey(t));
  const parity = Q.hasEvenY() ? 0 : 1;
  return [u.pointToBytes(Q), parity];
}
var TAPROOT_UNSPENDABLE_KEY = sha256(Point3.BASE.toRawBytes(false));
var NETWORK = {
  bech32: "bc",
  pubKeyHash: 0,
  scriptHash: 5,
  wif: 128
};
var TEST_NETWORK = {
  bech32: "tb",
  pubKeyHash: 111,
  scriptHash: 196,
  wif: 239
};
function compareBytes(a, b) {
  if (!isBytes4(a) || !isBytes4(b))
    throw new Error(`cmp: wrong type a=${typeof a} b=${typeof b}`);
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++)
    if (a[i] != b[i])
      return Math.sign(a[i] - b[i]);
  return Math.sign(a.length - b.length);
}

// node_modules/@scure/btc-signer/esm/script.js
var MAX_SCRIPT_BYTE_LENGTH = 520;
var OP;
(function(OP2) {
  OP2[OP2["OP_0"] = 0] = "OP_0";
  OP2[OP2["PUSHDATA1"] = 76] = "PUSHDATA1";
  OP2[OP2["PUSHDATA2"] = 77] = "PUSHDATA2";
  OP2[OP2["PUSHDATA4"] = 78] = "PUSHDATA4";
  OP2[OP2["1NEGATE"] = 79] = "1NEGATE";
  OP2[OP2["RESERVED"] = 80] = "RESERVED";
  OP2[OP2["OP_1"] = 81] = "OP_1";
  OP2[OP2["OP_2"] = 82] = "OP_2";
  OP2[OP2["OP_3"] = 83] = "OP_3";
  OP2[OP2["OP_4"] = 84] = "OP_4";
  OP2[OP2["OP_5"] = 85] = "OP_5";
  OP2[OP2["OP_6"] = 86] = "OP_6";
  OP2[OP2["OP_7"] = 87] = "OP_7";
  OP2[OP2["OP_8"] = 88] = "OP_8";
  OP2[OP2["OP_9"] = 89] = "OP_9";
  OP2[OP2["OP_10"] = 90] = "OP_10";
  OP2[OP2["OP_11"] = 91] = "OP_11";
  OP2[OP2["OP_12"] = 92] = "OP_12";
  OP2[OP2["OP_13"] = 93] = "OP_13";
  OP2[OP2["OP_14"] = 94] = "OP_14";
  OP2[OP2["OP_15"] = 95] = "OP_15";
  OP2[OP2["OP_16"] = 96] = "OP_16";
  OP2[OP2["NOP"] = 97] = "NOP";
  OP2[OP2["VER"] = 98] = "VER";
  OP2[OP2["IF"] = 99] = "IF";
  OP2[OP2["NOTIF"] = 100] = "NOTIF";
  OP2[OP2["VERIF"] = 101] = "VERIF";
  OP2[OP2["VERNOTIF"] = 102] = "VERNOTIF";
  OP2[OP2["ELSE"] = 103] = "ELSE";
  OP2[OP2["ENDIF"] = 104] = "ENDIF";
  OP2[OP2["VERIFY"] = 105] = "VERIFY";
  OP2[OP2["RETURN"] = 106] = "RETURN";
  OP2[OP2["TOALTSTACK"] = 107] = "TOALTSTACK";
  OP2[OP2["FROMALTSTACK"] = 108] = "FROMALTSTACK";
  OP2[OP2["2DROP"] = 109] = "2DROP";
  OP2[OP2["2DUP"] = 110] = "2DUP";
  OP2[OP2["3DUP"] = 111] = "3DUP";
  OP2[OP2["2OVER"] = 112] = "2OVER";
  OP2[OP2["2ROT"] = 113] = "2ROT";
  OP2[OP2["2SWAP"] = 114] = "2SWAP";
  OP2[OP2["IFDUP"] = 115] = "IFDUP";
  OP2[OP2["DEPTH"] = 116] = "DEPTH";
  OP2[OP2["DROP"] = 117] = "DROP";
  OP2[OP2["DUP"] = 118] = "DUP";
  OP2[OP2["NIP"] = 119] = "NIP";
  OP2[OP2["OVER"] = 120] = "OVER";
  OP2[OP2["PICK"] = 121] = "PICK";
  OP2[OP2["ROLL"] = 122] = "ROLL";
  OP2[OP2["ROT"] = 123] = "ROT";
  OP2[OP2["SWAP"] = 124] = "SWAP";
  OP2[OP2["TUCK"] = 125] = "TUCK";
  OP2[OP2["CAT"] = 126] = "CAT";
  OP2[OP2["SUBSTR"] = 127] = "SUBSTR";
  OP2[OP2["LEFT"] = 128] = "LEFT";
  OP2[OP2["RIGHT"] = 129] = "RIGHT";
  OP2[OP2["SIZE"] = 130] = "SIZE";
  OP2[OP2["INVERT"] = 131] = "INVERT";
  OP2[OP2["AND"] = 132] = "AND";
  OP2[OP2["OR"] = 133] = "OR";
  OP2[OP2["XOR"] = 134] = "XOR";
  OP2[OP2["EQUAL"] = 135] = "EQUAL";
  OP2[OP2["EQUALVERIFY"] = 136] = "EQUALVERIFY";
  OP2[OP2["RESERVED1"] = 137] = "RESERVED1";
  OP2[OP2["RESERVED2"] = 138] = "RESERVED2";
  OP2[OP2["1ADD"] = 139] = "1ADD";
  OP2[OP2["1SUB"] = 140] = "1SUB";
  OP2[OP2["2MUL"] = 141] = "2MUL";
  OP2[OP2["2DIV"] = 142] = "2DIV";
  OP2[OP2["NEGATE"] = 143] = "NEGATE";
  OP2[OP2["ABS"] = 144] = "ABS";
  OP2[OP2["NOT"] = 145] = "NOT";
  OP2[OP2["0NOTEQUAL"] = 146] = "0NOTEQUAL";
  OP2[OP2["ADD"] = 147] = "ADD";
  OP2[OP2["SUB"] = 148] = "SUB";
  OP2[OP2["MUL"] = 149] = "MUL";
  OP2[OP2["DIV"] = 150] = "DIV";
  OP2[OP2["MOD"] = 151] = "MOD";
  OP2[OP2["LSHIFT"] = 152] = "LSHIFT";
  OP2[OP2["RSHIFT"] = 153] = "RSHIFT";
  OP2[OP2["BOOLAND"] = 154] = "BOOLAND";
  OP2[OP2["BOOLOR"] = 155] = "BOOLOR";
  OP2[OP2["NUMEQUAL"] = 156] = "NUMEQUAL";
  OP2[OP2["NUMEQUALVERIFY"] = 157] = "NUMEQUALVERIFY";
  OP2[OP2["NUMNOTEQUAL"] = 158] = "NUMNOTEQUAL";
  OP2[OP2["LESSTHAN"] = 159] = "LESSTHAN";
  OP2[OP2["GREATERTHAN"] = 160] = "GREATERTHAN";
  OP2[OP2["LESSTHANOREQUAL"] = 161] = "LESSTHANOREQUAL";
  OP2[OP2["GREATERTHANOREQUAL"] = 162] = "GREATERTHANOREQUAL";
  OP2[OP2["MIN"] = 163] = "MIN";
  OP2[OP2["MAX"] = 164] = "MAX";
  OP2[OP2["WITHIN"] = 165] = "WITHIN";
  OP2[OP2["RIPEMD160"] = 166] = "RIPEMD160";
  OP2[OP2["SHA1"] = 167] = "SHA1";
  OP2[OP2["SHA256"] = 168] = "SHA256";
  OP2[OP2["HASH160"] = 169] = "HASH160";
  OP2[OP2["HASH256"] = 170] = "HASH256";
  OP2[OP2["CODESEPARATOR"] = 171] = "CODESEPARATOR";
  OP2[OP2["CHECKSIG"] = 172] = "CHECKSIG";
  OP2[OP2["CHECKSIGVERIFY"] = 173] = "CHECKSIGVERIFY";
  OP2[OP2["CHECKMULTISIG"] = 174] = "CHECKMULTISIG";
  OP2[OP2["CHECKMULTISIGVERIFY"] = 175] = "CHECKMULTISIGVERIFY";
  OP2[OP2["NOP1"] = 176] = "NOP1";
  OP2[OP2["CHECKLOCKTIMEVERIFY"] = 177] = "CHECKLOCKTIMEVERIFY";
  OP2[OP2["CHECKSEQUENCEVERIFY"] = 178] = "CHECKSEQUENCEVERIFY";
  OP2[OP2["NOP4"] = 179] = "NOP4";
  OP2[OP2["NOP5"] = 180] = "NOP5";
  OP2[OP2["NOP6"] = 181] = "NOP6";
  OP2[OP2["NOP7"] = 182] = "NOP7";
  OP2[OP2["NOP8"] = 183] = "NOP8";
  OP2[OP2["NOP9"] = 184] = "NOP9";
  OP2[OP2["NOP10"] = 185] = "NOP10";
  OP2[OP2["CHECKSIGADD"] = 186] = "CHECKSIGADD";
  OP2[OP2["INVALID"] = 255] = "INVALID";
})(OP || (OP = {}));
function ScriptNum(bytesLimit = 6, forceMinimal = false) {
  return wrap({
    encodeStream: (w, value) => {
      if (value === 0n)
        return;
      const neg = value < 0;
      const val = BigInt(value);
      const nums = [];
      for (let abs = neg ? -val : val; abs; abs >>= 8n)
        nums.push(Number(abs & 0xffn));
      if (nums[nums.length - 1] >= 128)
        nums.push(neg ? 128 : 0);
      else if (neg)
        nums[nums.length - 1] |= 128;
      w.bytes(new Uint8Array(nums));
    },
    decodeStream: (r) => {
      const len = r.leftBytes;
      if (len > bytesLimit)
        throw new Error(`ScriptNum: number (${len}) bigger than limit=${bytesLimit}`);
      if (len === 0)
        return 0n;
      if (forceMinimal) {
        const data = r.bytes(len, true);
        if ((data[data.length - 1] & 127) === 0) {
          if (len <= 1 || (data[data.length - 2] & 128) === 0)
            throw new Error("Non-minimally encoded ScriptNum");
        }
      }
      let last = 0;
      let res = 0n;
      for (let i = 0; i < len; ++i) {
        last = r.byte();
        res |= BigInt(last) << 8n * BigInt(i);
      }
      if (last >= 128) {
        res &= 2n ** BigInt(len * 8) - 1n >> 1n;
        res = -res;
      }
      return res;
    }
  });
}
function OpToNum(op, bytesLimit = 4, forceMinimal = true) {
  if (typeof op === "number")
    return op;
  if (isBytes4(op)) {
    try {
      const val = ScriptNum(bytesLimit, forceMinimal).decode(op);
      if (val > Number.MAX_SAFE_INTEGER)
        return;
      return Number(val);
    } catch (e) {
      return;
    }
  }
  return;
}
var Script = wrap({
  encodeStream: (w, value) => {
    for (let o of value) {
      if (typeof o === "string") {
        if (OP[o] === void 0)
          throw new Error(`Unknown opcode=${o}`);
        w.byte(OP[o]);
        continue;
      } else if (typeof o === "number") {
        if (o === 0) {
          w.byte(0);
          continue;
        } else if (1 <= o && o <= 16) {
          w.byte(OP.OP_1 - 1 + o);
          continue;
        }
      }
      if (typeof o === "number")
        o = ScriptNum().encode(BigInt(o));
      if (!isBytes4(o))
        throw new Error(`Wrong Script OP=${o} (${typeof o})`);
      const len = o.length;
      if (len < OP.PUSHDATA1)
        w.byte(len);
      else if (len <= 255) {
        w.byte(OP.PUSHDATA1);
        w.byte(len);
      } else if (len <= 65535) {
        w.byte(OP.PUSHDATA2);
        w.bytes(U16LE.encode(len));
      } else {
        w.byte(OP.PUSHDATA4);
        w.bytes(U32LE.encode(len));
      }
      w.bytes(o);
    }
  },
  decodeStream: (r) => {
    const out = [];
    while (!r.isEnd()) {
      const cur = r.byte();
      if (OP.OP_0 < cur && cur <= OP.PUSHDATA4) {
        let len;
        if (cur < OP.PUSHDATA1)
          len = cur;
        else if (cur === OP.PUSHDATA1)
          len = U8.decodeStream(r);
        else if (cur === OP.PUSHDATA2)
          len = U16LE.decodeStream(r);
        else if (cur === OP.PUSHDATA4)
          len = U32LE.decodeStream(r);
        else
          throw new Error("Should be not possible");
        out.push(r.bytes(len));
      } else if (cur === 0) {
        out.push(0);
      } else if (OP.OP_1 <= cur && cur <= OP.OP_16) {
        out.push(cur - (OP.OP_1 - 1));
      } else {
        const op = OP[cur];
        if (op === void 0)
          throw new Error(`Unknown opcode=${cur.toString(16)}`);
        out.push(op);
      }
    }
    return out;
  }
});
var CSLimits = {
  253: [253, 2, 253n, 65535n],
  254: [254, 4, 65536n, 4294967295n],
  255: [255, 8, 4294967296n, 18446744073709551615n]
};
var CompactSize = wrap({
  encodeStream: (w, value) => {
    if (typeof value === "number")
      value = BigInt(value);
    if (0n <= value && value <= 252n)
      return w.byte(Number(value));
    for (const [flag2, bytes, start, stop] of Object.values(CSLimits)) {
      if (start > value || value > stop)
        continue;
      w.byte(flag2);
      for (let i = 0; i < bytes; i++)
        w.byte(Number(value >> 8n * BigInt(i) & 0xffn));
      return;
    }
    throw w.err(`VarInt too big: ${value}`);
  },
  decodeStream: (r) => {
    const b0 = r.byte();
    if (b0 <= 252)
      return BigInt(b0);
    const [_, bytes, start] = CSLimits[b0];
    let num2 = 0n;
    for (let i = 0; i < bytes; i++)
      num2 |= BigInt(r.byte()) << 8n * BigInt(i);
    if (num2 < start)
      throw r.err(`Wrong CompactSize(${8 * bytes})`);
    return num2;
  }
});
var CompactSizeLen = apply(CompactSize, coders.numberBigint);
var VarBytes = createBytes(CompactSize);
var RawWitness = array(CompactSizeLen, VarBytes);
var BTCArray = (t) => array(CompactSize, t);
var RawInput = struct({
  txid: createBytes(32, true),
  // hash(prev_tx),
  index: U32LE,
  // output number of previous tx
  finalScriptSig: VarBytes,
  // btc merges input and output script, executes it. If ok = tx passes
  sequence: U32LE
  // ?
});
var RawOutput = struct({ amount: U64LE, script: VarBytes });
var _RawTx = struct({
  version: I32LE,
  segwitFlag: flag(new Uint8Array([0, 1])),
  inputs: BTCArray(RawInput),
  outputs: BTCArray(RawOutput),
  witnesses: flagged("segwitFlag", array("inputs/length", RawWitness)),
  // < 500000000	Block number at which this transaction is unlocked
  // >= 500000000	UNIX timestamp at which this transaction is unlocked
  // Handled as part of PSBTv2
  lockTime: U32LE
});
function validateRawTx(tx) {
  if (tx.segwitFlag && tx.witnesses && !tx.witnesses.length)
    throw new Error("Segwit flag with empty witnesses array");
  return tx;
}
var RawTx = validate(_RawTx, validateRawTx);
var RawOldTx = struct({
  version: I32LE,
  inputs: BTCArray(RawInput),
  outputs: BTCArray(RawOutput),
  lockTime: U32LE
});

// node_modules/@scure/btc-signer/esm/psbt.js
var PubKeyECDSA = validate(createBytes(null), (pub) => validatePubkey(pub, PubT.ecdsa));
var PubKeySchnorr = validate(createBytes(32), (pub) => validatePubkey(pub, PubT.schnorr));
var SignatureSchnorr = validate(createBytes(null), (sig) => {
  if (sig.length !== 64 && sig.length !== 65)
    throw new Error("Schnorr signature should be 64 or 65 bytes long");
  return sig;
});
var BIP32Der = struct({
  fingerprint: U32BE,
  path: array(null, U32LE)
});
var TaprootBIP32Der = struct({
  hashes: array(CompactSizeLen, createBytes(32)),
  der: BIP32Der
});
var GlobalXPUB = createBytes(78);
var tapScriptSigKey = struct({ pubKey: PubKeySchnorr, leafHash: createBytes(32) });
var _TaprootControlBlock = struct({
  version: U8,
  // With parity :(
  internalKey: createBytes(32),
  merklePath: array(null, createBytes(32))
});
var TaprootControlBlock = validate(_TaprootControlBlock, (cb) => {
  if (cb.merklePath.length > 128)
    throw new Error("TaprootControlBlock: merklePath should be of length 0..128 (inclusive)");
  return cb;
});
var tapTree = array(null, struct({
  depth: U8,
  version: U8,
  script: VarBytes
}));
var BytesInf = createBytes(null);
var Bytes20 = createBytes(20);
var Bytes32 = createBytes(32);
var PSBTGlobal = {
  unsignedTx: [0, false, RawOldTx, [0], [0], false],
  xpub: [1, GlobalXPUB, BIP32Der, [], [0, 2], false],
  txVersion: [2, false, U32LE, [2], [2], false],
  fallbackLocktime: [3, false, U32LE, [], [2], false],
  inputCount: [4, false, CompactSizeLen, [2], [2], false],
  outputCount: [5, false, CompactSizeLen, [2], [2], false],
  txModifiable: [6, false, U8, [], [2], false],
  // TODO: bitfield
  version: [251, false, U32LE, [], [0, 2], false],
  proprietary: [252, BytesInf, BytesInf, [], [0, 2], false]
};
var PSBTInput = {
  nonWitnessUtxo: [0, false, RawTx, [], [0, 2], false],
  witnessUtxo: [1, false, RawOutput, [], [0, 2], false],
  partialSig: [2, PubKeyECDSA, BytesInf, [], [0, 2], false],
  sighashType: [3, false, U32LE, [], [0, 2], false],
  redeemScript: [4, false, BytesInf, [], [0, 2], false],
  witnessScript: [5, false, BytesInf, [], [0, 2], false],
  bip32Derivation: [6, PubKeyECDSA, BIP32Der, [], [0, 2], false],
  finalScriptSig: [7, false, BytesInf, [], [0, 2], false],
  finalScriptWitness: [8, false, RawWitness, [], [0, 2], false],
  porCommitment: [9, false, BytesInf, [], [0, 2], false],
  ripemd160: [10, Bytes20, BytesInf, [], [0, 2], false],
  sha256: [11, Bytes32, BytesInf, [], [0, 2], false],
  hash160: [12, Bytes20, BytesInf, [], [0, 2], false],
  hash256: [13, Bytes32, BytesInf, [], [0, 2], false],
  txid: [14, false, Bytes32, [2], [2], true],
  index: [15, false, U32LE, [2], [2], true],
  sequence: [16, false, U32LE, [], [2], true],
  requiredTimeLocktime: [17, false, U32LE, [], [2], false],
  requiredHeightLocktime: [18, false, U32LE, [], [2], false],
  tapKeySig: [19, false, SignatureSchnorr, [], [0, 2], false],
  tapScriptSig: [20, tapScriptSigKey, SignatureSchnorr, [], [0, 2], false],
  tapLeafScript: [21, TaprootControlBlock, BytesInf, [], [0, 2], false],
  tapBip32Derivation: [22, Bytes32, TaprootBIP32Der, [], [0, 2], false],
  tapInternalKey: [23, false, PubKeySchnorr, [], [0, 2], false],
  tapMerkleRoot: [24, false, Bytes32, [], [0, 2], false],
  proprietary: [252, BytesInf, BytesInf, [], [0, 2], false]
};
var PSBTInputFinalKeys = [
  "txid",
  "sequence",
  "index",
  "witnessUtxo",
  "nonWitnessUtxo",
  "finalScriptSig",
  "finalScriptWitness",
  "unknown"
];
var PSBTInputUnsignedKeys = [
  "partialSig",
  "finalScriptSig",
  "finalScriptWitness",
  "tapKeySig",
  "tapScriptSig"
];
var PSBTOutput = {
  redeemScript: [0, false, BytesInf, [], [0, 2], false],
  witnessScript: [1, false, BytesInf, [], [0, 2], false],
  bip32Derivation: [2, PubKeyECDSA, BIP32Der, [], [0, 2], false],
  amount: [3, false, I64LE, [2], [2], true],
  script: [4, false, BytesInf, [2], [2], true],
  tapInternalKey: [5, false, PubKeySchnorr, [], [0, 2], false],
  tapTree: [6, false, tapTree, [], [0, 2], false],
  tapBip32Derivation: [7, PubKeySchnorr, TaprootBIP32Der, [], [0, 2], false],
  proprietary: [252, BytesInf, BytesInf, [], [0, 2], false]
};
var PSBTOutputUnsignedKeys = [];
var PSBTKeyPair = array(NULL, struct({
  //  <key> := <keylen> <keytype> <keydata> WHERE keylen = len(keytype)+len(keydata)
  key: prefix(CompactSizeLen, struct({ type: CompactSizeLen, key: createBytes(null) })),
  //  <value> := <valuelen> <valuedata>
  value: createBytes(CompactSizeLen)
}));
function PSBTKeyInfo(info) {
  const [type, kc, vc, reqInc, allowInc, silentIgnore] = info;
  return { type, kc, vc, reqInc, allowInc, silentIgnore };
}
var PSBTUnknownKey = struct({ type: CompactSizeLen, key: createBytes(null) });
function PSBTKeyMap(psbtEnum) {
  const byType = {};
  for (const k in psbtEnum) {
    const [num2, kc, vc] = psbtEnum[k];
    byType[num2] = [k, kc, vc];
  }
  return wrap({
    encodeStream: (w, value) => {
      let out = [];
      for (const name in psbtEnum) {
        const val = value[name];
        if (val === void 0)
          continue;
        const [type, kc, vc] = psbtEnum[name];
        if (!kc) {
          out.push({ key: { type, key: EMPTY }, value: vc.encode(val) });
        } else {
          const kv = val.map(([k, v]) => [
            kc.encode(k),
            vc.encode(v)
          ]);
          kv.sort((a, b) => compareBytes(a[0], b[0]));
          for (const [key, value2] of kv)
            out.push({ key: { key, type }, value: value2 });
        }
      }
      if (value.unknown) {
        value.unknown.sort((a, b) => compareBytes(a[0].key, b[0].key));
        for (const [k, v] of value.unknown)
          out.push({ key: k, value: v });
      }
      PSBTKeyPair.encodeStream(w, out);
    },
    decodeStream: (r) => {
      const raw = PSBTKeyPair.decodeStream(r);
      const out = {};
      const noKey = {};
      for (const elm of raw) {
        let name = "unknown";
        let key = elm.key.key;
        let value = elm.value;
        if (byType[elm.key.type]) {
          const [_name, kc, vc] = byType[elm.key.type];
          name = _name;
          if (!kc && key.length) {
            throw new Error(`PSBT: Non-empty key for ${name} (key=${hex.encode(key)} value=${hex.encode(value)}`);
          }
          key = kc ? kc.decode(key) : void 0;
          value = vc.decode(value);
          if (!kc) {
            if (out[name])
              throw new Error(`PSBT: Same keys: ${name} (key=${key} value=${value})`);
            out[name] = value;
            noKey[name] = true;
            continue;
          }
        } else {
          key = { type: elm.key.type, key: elm.key.key };
        }
        if (noKey[name])
          throw new Error(`PSBT: Key type with empty key and no key=${name} val=${value}`);
        if (!out[name])
          out[name] = [];
        out[name].push([key, value]);
      }
      return out;
    }
  });
}
var PSBTInputCoder = validate(PSBTKeyMap(PSBTInput), (i) => {
  if (i.finalScriptWitness && !i.finalScriptWitness.length)
    throw new Error("validateInput: empty finalScriptWitness");
  if (i.partialSig && !i.partialSig.length)
    throw new Error("Empty partialSig");
  if (i.partialSig)
    for (const [k] of i.partialSig)
      validatePubkey(k, PubT.ecdsa);
  if (i.bip32Derivation)
    for (const [k] of i.bip32Derivation)
      validatePubkey(k, PubT.ecdsa);
  if (i.requiredTimeLocktime !== void 0 && i.requiredTimeLocktime < 5e8)
    throw new Error(`validateInput: wrong timeLocktime=${i.requiredTimeLocktime}`);
  if (i.requiredHeightLocktime !== void 0 && (i.requiredHeightLocktime <= 0 || i.requiredHeightLocktime >= 5e8))
    throw new Error(`validateInput: wrong heighLocktime=${i.requiredHeightLocktime}`);
  if (i.tapLeafScript) {
    for (const [k, v] of i.tapLeafScript) {
      if ((k.version & 254) !== v[v.length - 1])
        throw new Error("validateInput: tapLeafScript version mimatch");
      if (v[v.length - 1] & 1)
        throw new Error("validateInput: tapLeafScript version has parity bit!");
    }
  }
  return i;
});
var PSBTOutputCoder = validate(PSBTKeyMap(PSBTOutput), (o) => {
  if (o.bip32Derivation)
    for (const [k] of o.bip32Derivation)
      validatePubkey(k, PubT.ecdsa);
  return o;
});
var PSBTGlobalCoder = validate(PSBTKeyMap(PSBTGlobal), (g) => {
  const version = g.version || 0;
  if (version === 0) {
    if (!g.unsignedTx)
      throw new Error("PSBTv0: missing unsignedTx");
    for (const inp of g.unsignedTx.inputs)
      if (inp.finalScriptSig && inp.finalScriptSig.length)
        throw new Error("PSBTv0: input scriptSig found in unsignedTx");
  }
  return g;
});
var _RawPSBTV0 = struct({
  magic: magic(string(new Uint8Array([255])), "psbt"),
  global: PSBTGlobalCoder,
  inputs: array("global/unsignedTx/inputs/length", PSBTInputCoder),
  outputs: array(null, PSBTOutputCoder)
});
var _RawPSBTV2 = struct({
  magic: magic(string(new Uint8Array([255])), "psbt"),
  global: PSBTGlobalCoder,
  inputs: array("global/inputCount", PSBTInputCoder),
  outputs: array("global/outputCount", PSBTOutputCoder)
});
var _DebugPSBT = struct({
  magic: magic(string(new Uint8Array([255])), "psbt"),
  items: array(null, apply(array(NULL, tuple([createHex(CompactSizeLen), createBytes(CompactSize)])), coders.dict()))
});
function validatePSBTFields(version, info, lst) {
  for (const k in lst) {
    if (k === "unknown")
      continue;
    if (!info[k])
      continue;
    const { allowInc } = PSBTKeyInfo(info[k]);
    if (!allowInc.includes(version))
      throw new Error(`PSBTv${version}: field ${k} is not allowed`);
  }
  for (const k in info) {
    const { reqInc } = PSBTKeyInfo(info[k]);
    if (reqInc.includes(version) && lst[k] === void 0)
      throw new Error(`PSBTv${version}: missing required field ${k}`);
  }
}
function cleanPSBTFields(version, info, lst) {
  const out = {};
  for (const _k in lst) {
    const k = _k;
    if (k !== "unknown") {
      if (!info[k])
        continue;
      const { allowInc, silentIgnore } = PSBTKeyInfo(info[k]);
      if (!allowInc.includes(version)) {
        if (silentIgnore)
          continue;
        throw new Error(`Failed to serialize in PSBTv${version}: ${k} but versions allows inclusion=${allowInc}`);
      }
    }
    out[k] = lst[k];
  }
  return out;
}
function validatePSBT(tx) {
  const version = tx && tx.global && tx.global.version || 0;
  validatePSBTFields(version, PSBTGlobal, tx.global);
  for (const i of tx.inputs)
    validatePSBTFields(version, PSBTInput, i);
  for (const o of tx.outputs)
    validatePSBTFields(version, PSBTOutput, o);
  const inputCount = !version ? tx.global.unsignedTx.inputs.length : tx.global.inputCount;
  if (tx.inputs.length < inputCount)
    throw new Error("Not enough inputs");
  const inputsLeft = tx.inputs.slice(inputCount);
  if (inputsLeft.length > 1 || inputsLeft.length && Object.keys(inputsLeft[0]).length)
    throw new Error(`Unexpected inputs left in tx=${inputsLeft}`);
  const outputCount = !version ? tx.global.unsignedTx.outputs.length : tx.global.outputCount;
  if (tx.outputs.length < outputCount)
    throw new Error("Not outputs inputs");
  const outputsLeft = tx.outputs.slice(outputCount);
  if (outputsLeft.length > 1 || outputsLeft.length && Object.keys(outputsLeft[0]).length)
    throw new Error(`Unexpected outputs left in tx=${outputsLeft}`);
  return tx;
}
function mergeKeyMap(psbtEnum, val, cur, allowedFields, allowUnknown) {
  const res = { ...cur, ...val };
  for (const k in psbtEnum) {
    const key = k;
    const [_, kC, vC] = psbtEnum[key];
    const cannotChange = allowedFields && !allowedFields.includes(k);
    if (val[k] === void 0 && k in val) {
      if (cannotChange)
        throw new Error(`Cannot remove signed field=${k}`);
      delete res[k];
    } else if (kC) {
      const oldKV = cur && cur[k] ? cur[k] : [];
      let newKV = val[key];
      if (newKV) {
        if (!Array.isArray(newKV))
          throw new Error(`keyMap(${k}): KV pairs should be [k, v][]`);
        newKV = newKV.map((val2) => {
          if (val2.length !== 2)
            throw new Error(`keyMap(${k}): KV pairs should be [k, v][]`);
          return [
            typeof val2[0] === "string" ? kC.decode(hex.decode(val2[0])) : val2[0],
            typeof val2[1] === "string" ? vC.decode(hex.decode(val2[1])) : val2[1]
          ];
        });
        const map = {};
        const add2 = (kStr, k2, v) => {
          if (map[kStr] === void 0) {
            map[kStr] = [k2, v];
            return;
          }
          const oldVal = hex.encode(vC.encode(map[kStr][1]));
          const newVal = hex.encode(vC.encode(v));
          if (oldVal !== newVal)
            throw new Error(`keyMap(${key}): same key=${kStr} oldVal=${oldVal} newVal=${newVal}`);
        };
        for (const [k2, v] of oldKV) {
          const kStr = hex.encode(kC.encode(k2));
          add2(kStr, k2, v);
        }
        for (const [k2, v] of newKV) {
          const kStr = hex.encode(kC.encode(k2));
          if (v === void 0) {
            if (cannotChange)
              throw new Error(`Cannot remove signed field=${key}/${k2}`);
            delete map[kStr];
          } else
            add2(kStr, k2, v);
        }
        res[key] = Object.values(map);
      }
    } else if (typeof res[k] === "string") {
      res[k] = vC.decode(hex.decode(res[k]));
    } else if (cannotChange && k in val && cur && cur[k] !== void 0) {
      if (!equalBytes2(vC.encode(val[k]), vC.encode(cur[k])))
        throw new Error(`Cannot change signed field=${k}`);
    }
  }
  for (const k in res) {
    if (!psbtEnum[k]) {
      if (allowUnknown && k === "unknown")
        continue;
      delete res[k];
    }
  }
  return res;
}
var RawPSBTV0 = validate(_RawPSBTV0, validatePSBT);
var RawPSBTV2 = validate(_RawPSBTV2, validatePSBT);

// node_modules/@scure/btc-signer/esm/payment.js
var OutP2A = {
  encode(from) {
    if (from.length !== 2 || from[0] !== 1 || !isBytes4(from[1]) || hex.encode(from[1]) !== "4e73")
      return;
    return { type: "p2a", script: Script.encode(from) };
  },
  decode: (to) => {
    if (to.type !== "p2a")
      return;
    return [1, hex.decode("4e73")];
  }
};
function isValidPubkey(pub, type) {
  try {
    validatePubkey(pub, type);
    return true;
  } catch (e) {
    return false;
  }
}
var OutPK = {
  encode(from) {
    if (from.length !== 2 || !isBytes4(from[0]) || !isValidPubkey(from[0], PubT.ecdsa) || from[1] !== "CHECKSIG")
      return;
    return { type: "pk", pubkey: from[0] };
  },
  decode: (to) => to.type === "pk" ? [to.pubkey, "CHECKSIG"] : void 0
};
var OutPKH = {
  encode(from) {
    if (from.length !== 5 || from[0] !== "DUP" || from[1] !== "HASH160" || !isBytes4(from[2]))
      return;
    if (from[3] !== "EQUALVERIFY" || from[4] !== "CHECKSIG")
      return;
    return { type: "pkh", hash: from[2] };
  },
  decode: (to) => to.type === "pkh" ? ["DUP", "HASH160", to.hash, "EQUALVERIFY", "CHECKSIG"] : void 0
};
var OutSH = {
  encode(from) {
    if (from.length !== 3 || from[0] !== "HASH160" || !isBytes4(from[1]) || from[2] !== "EQUAL")
      return;
    return { type: "sh", hash: from[1] };
  },
  decode: (to) => to.type === "sh" ? ["HASH160", to.hash, "EQUAL"] : void 0
};
var OutWSH = {
  encode(from) {
    if (from.length !== 2 || from[0] !== 0 || !isBytes4(from[1]))
      return;
    if (from[1].length !== 32)
      return;
    return { type: "wsh", hash: from[1] };
  },
  decode: (to) => to.type === "wsh" ? [0, to.hash] : void 0
};
var OutWPKH = {
  encode(from) {
    if (from.length !== 2 || from[0] !== 0 || !isBytes4(from[1]))
      return;
    if (from[1].length !== 20)
      return;
    return { type: "wpkh", hash: from[1] };
  },
  decode: (to) => to.type === "wpkh" ? [0, to.hash] : void 0
};
var OutMS = {
  encode(from) {
    const last = from.length - 1;
    if (from[last] !== "CHECKMULTISIG")
      return;
    const m = from[0];
    const n = from[last - 1];
    if (typeof m !== "number" || typeof n !== "number")
      return;
    const pubkeys = from.slice(1, -2);
    if (n !== pubkeys.length)
      return;
    for (const pub of pubkeys)
      if (!isBytes4(pub))
        return;
    return { type: "ms", m, pubkeys };
  },
  // checkmultisig(n, ..pubkeys, m)
  decode: (to) => to.type === "ms" ? [to.m, ...to.pubkeys, to.pubkeys.length, "CHECKMULTISIG"] : void 0
};
var OutTR = {
  encode(from) {
    if (from.length !== 2 || from[0] !== 1 || !isBytes4(from[1]))
      return;
    return { type: "tr", pubkey: from[1] };
  },
  decode: (to) => to.type === "tr" ? [1, to.pubkey] : void 0
};
var OutTRNS = {
  encode(from) {
    const last = from.length - 1;
    if (from[last] !== "CHECKSIG")
      return;
    const pubkeys = [];
    for (let i = 0; i < last; i++) {
      const elm = from[i];
      if (i & 1) {
        if (elm !== "CHECKSIGVERIFY" || i === last - 1)
          return;
        continue;
      }
      if (!isBytes4(elm))
        return;
      pubkeys.push(elm);
    }
    return { type: "tr_ns", pubkeys };
  },
  decode: (to) => {
    if (to.type !== "tr_ns")
      return;
    const out = [];
    for (let i = 0; i < to.pubkeys.length - 1; i++)
      out.push(to.pubkeys[i], "CHECKSIGVERIFY");
    out.push(to.pubkeys[to.pubkeys.length - 1], "CHECKSIG");
    return out;
  }
};
var OutTRMS = {
  encode(from) {
    const last = from.length - 1;
    if (from[last] !== "NUMEQUAL" || from[1] !== "CHECKSIG")
      return;
    const pubkeys = [];
    const m = OpToNum(from[last - 1]);
    if (typeof m !== "number")
      return;
    for (let i = 0; i < last - 1; i++) {
      const elm = from[i];
      if (i & 1) {
        if (elm !== (i === 1 ? "CHECKSIG" : "CHECKSIGADD"))
          throw new Error("OutScript.encode/tr_ms: wrong element");
        continue;
      }
      if (!isBytes4(elm))
        throw new Error("OutScript.encode/tr_ms: wrong key element");
      pubkeys.push(elm);
    }
    return { type: "tr_ms", pubkeys, m };
  },
  decode: (to) => {
    if (to.type !== "tr_ms")
      return;
    const out = [to.pubkeys[0], "CHECKSIG"];
    for (let i = 1; i < to.pubkeys.length; i++)
      out.push(to.pubkeys[i], "CHECKSIGADD");
    out.push(to.m, "NUMEQUAL");
    return out;
  }
};
var OutUnknown = {
  encode(from) {
    return { type: "unknown", script: Script.encode(from) };
  },
  decode: (to) => to.type === "unknown" ? Script.decode(to.script) : void 0
};
var OutScripts = [
  OutP2A,
  OutPK,
  OutPKH,
  OutSH,
  OutWSH,
  OutWPKH,
  OutMS,
  OutTR,
  OutTRNS,
  OutTRMS,
  OutUnknown
];
var _OutScript = apply(Script, coders.match(OutScripts));
var OutScript = validate(_OutScript, (i) => {
  if (i.type === "pk" && !isValidPubkey(i.pubkey, PubT.ecdsa))
    throw new Error("OutScript/pk: wrong key");
  if ((i.type === "pkh" || i.type === "sh" || i.type === "wpkh") && (!isBytes4(i.hash) || i.hash.length !== 20))
    throw new Error(`OutScript/${i.type}: wrong hash`);
  if (i.type === "wsh" && (!isBytes4(i.hash) || i.hash.length !== 32))
    throw new Error(`OutScript/wsh: wrong hash`);
  if (i.type === "tr" && (!isBytes4(i.pubkey) || !isValidPubkey(i.pubkey, PubT.schnorr)))
    throw new Error("OutScript/tr: wrong taproot public key");
  if (i.type === "ms" || i.type === "tr_ns" || i.type === "tr_ms") {
    if (!Array.isArray(i.pubkeys))
      throw new Error("OutScript/multisig: wrong pubkeys array");
  }
  if (i.type === "ms") {
    const n = i.pubkeys.length;
    for (const p of i.pubkeys)
      if (!isValidPubkey(p, PubT.ecdsa))
        throw new Error("OutScript/multisig: wrong pubkey");
    if (i.m <= 0 || n > 16 || i.m > n)
      throw new Error("OutScript/multisig: invalid params");
  }
  if (i.type === "tr_ns" || i.type === "tr_ms") {
    for (const p of i.pubkeys)
      if (!isValidPubkey(p, PubT.schnorr))
        throw new Error(`OutScript/${i.type}: wrong pubkey`);
  }
  if (i.type === "tr_ms") {
    const n = i.pubkeys.length;
    if (i.m <= 0 || n > 999 || i.m > n)
      throw new Error("OutScript/tr_ms: invalid params");
  }
  return i;
});
function checkWSH(s, witnessScript) {
  if (!equalBytes2(s.hash, sha256(witnessScript)))
    throw new Error("checkScript: wsh wrong witnessScript hash");
  const w = OutScript.decode(witnessScript);
  if (w.type === "tr" || w.type === "tr_ns" || w.type === "tr_ms")
    throw new Error(`checkScript: P2${w.type} cannot be wrapped in P2SH`);
  if (w.type === "wpkh" || w.type === "sh")
    throw new Error(`checkScript: P2${w.type} cannot be wrapped in P2WSH`);
}
function checkScript(script, redeemScript, witnessScript) {
  if (script) {
    const s = OutScript.decode(script);
    if (s.type === "tr_ns" || s.type === "tr_ms" || s.type === "ms" || s.type == "pk")
      throw new Error(`checkScript: non-wrapped ${s.type}`);
    if (s.type === "sh" && redeemScript) {
      if (!equalBytes2(s.hash, hash1602(redeemScript)))
        throw new Error("checkScript: sh wrong redeemScript hash");
      const r = OutScript.decode(redeemScript);
      if (r.type === "tr" || r.type === "tr_ns" || r.type === "tr_ms")
        throw new Error(`checkScript: P2${r.type} cannot be wrapped in P2SH`);
      if (r.type === "sh")
        throw new Error("checkScript: P2SH cannot be wrapped in P2SH");
    }
    if (s.type === "wsh" && witnessScript)
      checkWSH(s, witnessScript);
  }
  if (redeemScript) {
    const r = OutScript.decode(redeemScript);
    if (r.type === "wsh" && witnessScript)
      checkWSH(r, witnessScript);
  }
}
function uniqPubkey(pubkeys) {
  const map = {};
  for (const pub of pubkeys) {
    const key = hex.encode(pub);
    if (map[key])
      throw new Error(`Multisig: non-uniq pubkey: ${pubkeys.map(hex.encode)}`);
    map[key] = true;
  }
}
var p2pk = (pubkey, _network = NETWORK) => {
  if (!isValidPubkey(pubkey, PubT.ecdsa))
    throw new Error("P2PK: invalid publicKey");
  return { type: "pk", script: OutScript.encode({ type: "pk", pubkey }) };
};
var p2pkh = (publicKey, network = NETWORK) => {
  if (!isValidPubkey(publicKey, PubT.ecdsa))
    throw new Error("P2PKH: invalid publicKey");
  const hash = hash1602(publicKey);
  return {
    type: "pkh",
    script: OutScript.encode({ type: "pkh", hash }),
    address: Address(network).encode({ type: "pkh", hash }),
    hash
  };
};
var p2sh = (child, network = NETWORK) => {
  const cs = child.script;
  if (!isBytes4(cs))
    throw new Error(`Wrong script: ${typeof child.script}, expected Uint8Array`);
  const hash = hash1602(cs);
  const script = OutScript.encode({ type: "sh", hash });
  checkScript(script, cs, child.witnessScript);
  if (child.witnessScript) {
    return {
      type: "sh",
      redeemScript: cs,
      script: OutScript.encode({ type: "sh", hash }),
      address: Address(network).encode({ type: "sh", hash }),
      hash,
      witnessScript: child.witnessScript
    };
  } else {
    return {
      type: "sh",
      redeemScript: cs,
      script: OutScript.encode({ type: "sh", hash }),
      address: Address(network).encode({ type: "sh", hash }),
      hash
    };
  }
};
var p2wsh = (child, network = NETWORK) => {
  const cs = child.script;
  if (!isBytes4(cs))
    throw new Error(`Wrong script: ${typeof cs}, expected Uint8Array`);
  const hash = sha256(cs);
  const script = OutScript.encode({ type: "wsh", hash });
  checkScript(script, void 0, cs);
  return {
    type: "wsh",
    witnessScript: cs,
    script: OutScript.encode({ type: "wsh", hash }),
    address: Address(network).encode({ type: "wsh", hash }),
    hash
  };
};
var p2wpkh = (publicKey, network = NETWORK) => {
  if (!isValidPubkey(publicKey, PubT.ecdsa))
    throw new Error("P2WPKH: invalid publicKey");
  if (publicKey.length === 65)
    throw new Error("P2WPKH: uncompressed public key");
  const hash = hash1602(publicKey);
  return {
    type: "wpkh",
    script: OutScript.encode({ type: "wpkh", hash }),
    address: Address(network).encode({ type: "wpkh", hash }),
    hash
  };
};
var p2ms = (m, pubkeys, allowSamePubkeys = false) => {
  if (!allowSamePubkeys)
    uniqPubkey(pubkeys);
  return {
    type: "ms",
    script: OutScript.encode({ type: "ms", pubkeys, m })
  };
};
function checkTaprootScript(script, internalPubKey, allowUnknownOutputs = false, customScripts) {
  const out = OutScript.decode(script);
  if (out.type === "unknown") {
    if (customScripts) {
      const cs = apply(Script, coders.match(customScripts));
      const c = cs.decode(script);
      if (c !== void 0) {
        if (typeof c.type !== "string" || !c.type.startsWith("tr_"))
          throw new Error(`P2TR: invalid custom type=${c.type}`);
        return;
      }
    }
    if (allowUnknownOutputs)
      return;
  }
  if (!["tr_ns", "tr_ms"].includes(out.type))
    throw new Error(`P2TR: invalid leaf script=${out.type}`);
  const outms = out;
  if (!allowUnknownOutputs && outms.pubkeys) {
    for (const p of outms.pubkeys) {
      if (equalBytes2(p, TAPROOT_UNSPENDABLE_KEY))
        throw new Error("Unspendable taproot key in leaf script");
      if (equalBytes2(p, internalPubKey)) {
        throw new Error("Using P2TR with leaf script with same key as internal key is not supported");
      }
    }
  }
}
function taprootListToTree(taprootList) {
  const lst = Array.from(taprootList);
  while (lst.length >= 2) {
    lst.sort((a2, b2) => (b2.weight || 1) - (a2.weight || 1));
    const b = lst.pop();
    const a = lst.pop();
    const weight = (a?.weight || 1) + (b?.weight || 1);
    lst.push({
      weight,
      // Unwrap children array
      // TODO: Very hard to remove any here
      childs: [a?.childs || a, b?.childs || b]
    });
  }
  const last = lst[0];
  return last?.childs || last;
}
function taprootAddPath(tree, path = []) {
  if (!tree)
    throw new Error(`taprootAddPath: empty tree`);
  if (tree.type === "leaf")
    return { ...tree, path };
  if (tree.type !== "branch")
    throw new Error(`taprootAddPath: wrong type=${tree}`);
  return {
    ...tree,
    path,
    // Left element has right hash in path and otherwise
    left: taprootAddPath(tree.left, [tree.right.hash, ...path]),
    right: taprootAddPath(tree.right, [tree.left.hash, ...path])
  };
}
function taprootWalkTree(tree) {
  if (!tree)
    throw new Error(`taprootAddPath: empty tree`);
  if (tree.type === "leaf")
    return [tree];
  if (tree.type !== "branch")
    throw new Error(`taprootWalkTree: wrong type=${tree}`);
  return [...taprootWalkTree(tree.left), ...taprootWalkTree(tree.right)];
}
function taprootHashTree(tree, internalPubKey, allowUnknownOutputs = false, customScripts) {
  if (!tree)
    throw new Error("taprootHashTree: empty tree");
  if (Array.isArray(tree) && tree.length === 1)
    tree = tree[0];
  if (!Array.isArray(tree)) {
    const { leafVersion: version, script: leafScript } = tree;
    if (tree.tapLeafScript || tree.tapMerkleRoot && !equalBytes2(tree.tapMerkleRoot, EMPTY))
      throw new Error("P2TR: tapRoot leafScript cannot have tree");
    const script = typeof leafScript === "string" ? hex.decode(leafScript) : leafScript;
    if (!isBytes4(script))
      throw new Error(`checkScript: wrong script type=${script}`);
    checkTaprootScript(script, internalPubKey, allowUnknownOutputs, customScripts);
    return {
      type: "leaf",
      version,
      script,
      hash: tapLeafHash(script, version)
    };
  }
  if (tree.length !== 2)
    tree = taprootListToTree(tree);
  if (tree.length !== 2)
    throw new Error("hashTree: non binary tree!");
  const left = taprootHashTree(tree[0], internalPubKey, allowUnknownOutputs, customScripts);
  const right = taprootHashTree(tree[1], internalPubKey, allowUnknownOutputs, customScripts);
  let [lH, rH] = [left.hash, right.hash];
  if (compareBytes(rH, lH) === -1)
    [lH, rH] = [rH, lH];
  return { type: "branch", left, right, hash: tagSchnorr("TapBranch", lH, rH) };
}
var TAP_LEAF_VERSION = 192;
var tapLeafHash = (script, version = TAP_LEAF_VERSION) => tagSchnorr("TapLeaf", new Uint8Array([version]), VarBytes.encode(script));
function p2tr(internalPubKey, tree, network = NETWORK, allowUnknownOutputs = false, customScripts) {
  if (!internalPubKey && !tree)
    throw new Error("p2tr: should have pubKey or scriptTree (or both)");
  const pubKey = typeof internalPubKey === "string" ? hex.decode(internalPubKey) : internalPubKey || TAPROOT_UNSPENDABLE_KEY;
  if (!isValidPubkey(pubKey, PubT.schnorr))
    throw new Error("p2tr: non-schnorr pubkey");
  if (tree) {
    let hashedTree = taprootAddPath(taprootHashTree(tree, pubKey, allowUnknownOutputs, customScripts));
    const tapMerkleRoot = hashedTree.hash;
    const [tweakedPubkey, parity] = taprootTweakPubkey(pubKey, tapMerkleRoot);
    const leaves = taprootWalkTree(hashedTree).map((l) => ({
      ...l,
      controlBlock: TaprootControlBlock.encode({
        version: (l.version || TAP_LEAF_VERSION) + parity,
        internalKey: pubKey,
        merklePath: l.path
      })
    }));
    return {
      type: "tr",
      script: OutScript.encode({ type: "tr", pubkey: tweakedPubkey }),
      address: Address(network).encode({ type: "tr", pubkey: tweakedPubkey }),
      // For tests
      tweakedPubkey,
      // PSBT stuff
      tapInternalKey: pubKey,
      leaves,
      tapLeafScript: leaves.map((l) => [
        TaprootControlBlock.decode(l.controlBlock),
        concatBytes3(l.script, new Uint8Array([l.version || TAP_LEAF_VERSION]))
      ]),
      tapMerkleRoot
    };
  } else {
    const tweakedPubkey = taprootTweakPubkey(pubKey, EMPTY)[0];
    return {
      type: "tr",
      script: OutScript.encode({ type: "tr", pubkey: tweakedPubkey }),
      address: Address(network).encode({ type: "tr", pubkey: tweakedPubkey }),
      // For tests
      tweakedPubkey,
      // PSBT stuff
      tapInternalKey: pubKey
    };
  }
}
function combinations(m, list) {
  const res = [];
  if (!Array.isArray(list))
    throw new Error("combinations: lst arg should be array");
  const n = list.length;
  if (m > n)
    throw new Error("combinations: m > lst.length, no combinations possible");
  const idx = Array.from({ length: m }, (_, i) => i);
  const last = idx.length - 1;
  main: for (; ; ) {
    res.push(idx.map((i2) => list[i2]));
    idx[last] += 1;
    let i = last;
    for (; i >= 0 && idx[i] > n - m + i; i--) {
      idx[i] = 0;
      if (i === 0)
        break main;
      idx[i - 1] += 1;
    }
    for (i += 1; i < idx.length; i++)
      idx[i] = idx[i - 1] + 1;
  }
  return res;
}
var p2tr_ns = (m, pubkeys, allowSamePubkeys = false) => {
  if (!allowSamePubkeys)
    uniqPubkey(pubkeys);
  return combinations(m, pubkeys).map((i) => ({
    type: "tr_ns",
    script: OutScript.encode({ type: "tr_ns", pubkeys: i })
  }));
};
var p2tr_pk = (pubkey) => p2tr_ns(1, [pubkey], void 0)[0];
function p2tr_ms(m, pubkeys, allowSamePubkeys = false) {
  if (!allowSamePubkeys)
    uniqPubkey(pubkeys);
  return {
    type: "tr_ms",
    script: OutScript.encode({ type: "tr_ms", pubkeys, m })
  };
}
function getAddress(type, privKey, network = NETWORK) {
  if (type === "tr") {
    return p2tr(pubSchnorr(privKey), void 0, network).address;
  }
  const pubKey = pubECDSA(privKey);
  if (type === "pkh")
    return p2pkh(pubKey, network).address;
  if (type === "wpkh")
    return p2wpkh(pubKey, network).address;
  throw new Error(`getAddress: unknown type=${type}`);
}
var _sortPubkeys = (pubkeys) => Array.from(pubkeys).sort(compareBytes);
function multisig(m, pubkeys, sorted = false, witness = false, network = NETWORK) {
  const ms = p2ms(m, sorted ? _sortPubkeys(pubkeys) : pubkeys);
  return witness ? p2wsh(ms, network) : p2sh(ms, network);
}
function sortedMultisig(m, pubkeys, witness = false, network = NETWORK) {
  return multisig(m, pubkeys, true, witness, network);
}
var base58check3 = createBase58check(sha256);
function validateWitness(version, data) {
  if (data.length < 2 || data.length > 40)
    throw new Error("Witness: invalid length");
  if (version > 16)
    throw new Error("Witness: invalid version");
  if (version === 0 && !(data.length === 20 || data.length === 32))
    throw new Error("Witness: invalid length for version");
}
function programToWitness(version, data, network = NETWORK) {
  validateWitness(version, data);
  const coder = version === 0 ? bech32 : bech32m;
  return coder.encode(network.bech32, [version].concat(coder.toWords(data)));
}
function formatKey(hashed, prefix2) {
  return base58check3.encode(concatBytes3(Uint8Array.from(prefix2), hashed));
}
function WIF(network = NETWORK) {
  return {
    encode(privKey) {
      const compressed = concatBytes3(privKey, new Uint8Array([1]));
      return formatKey(compressed.subarray(0, 33), [network.wif]);
    },
    decode(wif) {
      let parsed = base58check3.decode(wif);
      if (parsed[0] !== network.wif)
        throw new Error("Wrong WIF prefix");
      parsed = parsed.subarray(1);
      if (parsed.length !== 33)
        throw new Error("Wrong WIF length");
      if (parsed[32] !== 1)
        throw new Error("Wrong WIF postfix");
      return parsed.subarray(0, -1);
    }
  };
}
function Address(network = NETWORK) {
  return {
    encode(from) {
      const { type } = from;
      if (type === "wpkh")
        return programToWitness(0, from.hash, network);
      else if (type === "wsh")
        return programToWitness(0, from.hash, network);
      else if (type === "tr")
        return programToWitness(1, from.pubkey, network);
      else if (type === "pkh")
        return formatKey(from.hash, [network.pubKeyHash]);
      else if (type === "sh")
        return formatKey(from.hash, [network.scriptHash]);
      throw new Error(`Unknown address type=${type}`);
    },
    decode(address) {
      if (address.length < 14 || address.length > 74)
        throw new Error("Invalid address length");
      if (network.bech32 && address.toLowerCase().startsWith(`${network.bech32}1`)) {
        let res;
        try {
          res = bech32.decode(address);
          if (res.words[0] !== 0)
            throw new Error(`bech32: wrong version=${res.words[0]}`);
        } catch (_) {
          res = bech32m.decode(address);
          if (res.words[0] === 0)
            throw new Error(`bech32m: wrong version=${res.words[0]}`);
        }
        if (res.prefix !== network.bech32)
          throw new Error(`wrong bech32 prefix=${res.prefix}`);
        const [version, ...program] = res.words;
        const data2 = bech32.fromWords(program);
        validateWitness(version, data2);
        if (version === 0 && data2.length === 32)
          return { type: "wsh", hash: data2 };
        else if (version === 0 && data2.length === 20)
          return { type: "wpkh", hash: data2 };
        else if (version === 1 && data2.length === 32)
          return { type: "tr", pubkey: data2 };
        else
          throw new Error("Unknown witness program");
      }
      const data = base58check3.decode(address);
      if (data.length !== 21)
        throw new Error("Invalid base58 address");
      if (data[0] === network.pubKeyHash) {
        return { type: "pkh", hash: data.slice(1) };
      } else if (data[0] === network.scriptHash) {
        return {
          type: "sh",
          hash: data.slice(1)
        };
      }
      throw new Error(`Invalid address prefix=${data[0]}`);
    }
  };
}

// node_modules/@scure/btc-signer/esm/transaction.js
var EMPTY32 = new Uint8Array(32);
var EMPTY_OUTPUT = {
  amount: 0xffffffffffffffffn,
  script: EMPTY
};
var toVsize = (weight) => Math.ceil(weight / 4);
var PRECISION = 8;
var DEFAULT_VERSION = 2;
var DEFAULT_LOCKTIME = 0;
var DEFAULT_SEQUENCE = 4294967295;
var Decimal = coders.decimal(PRECISION);
var def = (value, def2) => value === void 0 ? def2 : value;
function cloneDeep(obj) {
  if (Array.isArray(obj))
    return obj.map((i) => cloneDeep(i));
  else if (isBytes4(obj))
    return Uint8Array.from(obj);
  else if (["number", "bigint", "boolean", "string", "undefined"].includes(typeof obj))
    return obj;
  else if (obj === null)
    return obj;
  else if (typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, cloneDeep(v)]));
  }
  throw new Error(`cloneDeep: unknown type=${obj} (${typeof obj})`);
}
var SignatureHash;
(function(SignatureHash2) {
  SignatureHash2[SignatureHash2["DEFAULT"] = 0] = "DEFAULT";
  SignatureHash2[SignatureHash2["ALL"] = 1] = "ALL";
  SignatureHash2[SignatureHash2["NONE"] = 2] = "NONE";
  SignatureHash2[SignatureHash2["SINGLE"] = 3] = "SINGLE";
  SignatureHash2[SignatureHash2["ANYONECANPAY"] = 128] = "ANYONECANPAY";
})(SignatureHash || (SignatureHash = {}));
var SigHash;
(function(SigHash2) {
  SigHash2[SigHash2["DEFAULT"] = 0] = "DEFAULT";
  SigHash2[SigHash2["ALL"] = 1] = "ALL";
  SigHash2[SigHash2["NONE"] = 2] = "NONE";
  SigHash2[SigHash2["SINGLE"] = 3] = "SINGLE";
  SigHash2[SigHash2["DEFAULT_ANYONECANPAY"] = 128] = "DEFAULT_ANYONECANPAY";
  SigHash2[SigHash2["ALL_ANYONECANPAY"] = 129] = "ALL_ANYONECANPAY";
  SigHash2[SigHash2["NONE_ANYONECANPAY"] = 130] = "NONE_ANYONECANPAY";
  SigHash2[SigHash2["SINGLE_ANYONECANPAY"] = 131] = "SINGLE_ANYONECANPAY";
})(SigHash || (SigHash = {}));
function getTaprootKeys(privKey, pubKey, internalKey, merkleRoot = EMPTY) {
  if (equalBytes2(internalKey, pubKey)) {
    privKey = taprootTweakPrivKey(privKey, merkleRoot);
    pubKey = pubSchnorr(privKey);
  }
  return { privKey, pubKey };
}
function outputBeforeSign(i) {
  if (i.script === void 0 || i.amount === void 0)
    throw new Error("Transaction/output: script and amount required");
  return { script: i.script, amount: i.amount };
}
function inputBeforeSign(i) {
  if (i.txid === void 0 || i.index === void 0)
    throw new Error("Transaction/input: txid and index required");
  return {
    txid: i.txid,
    index: i.index,
    sequence: def(i.sequence, DEFAULT_SEQUENCE),
    finalScriptSig: def(i.finalScriptSig, EMPTY)
  };
}
function cleanFinalInput(i) {
  for (const _k in i) {
    const k = _k;
    if (!PSBTInputFinalKeys.includes(k))
      delete i[k];
  }
}
var TxHashIdx = struct({ txid: createBytes(32, true), index: U32LE });
function validateSigHash(s) {
  if (typeof s !== "number" || typeof SigHash[s] !== "string")
    throw new Error(`Invalid SigHash=${s}`);
  return s;
}
function unpackSighash(hashType) {
  const masked = hashType & 31;
  return {
    isAny: !!(hashType & SignatureHash.ANYONECANPAY),
    isNone: masked === SignatureHash.NONE,
    isSingle: masked === SignatureHash.SINGLE
  };
}
function validateOpts(opts) {
  if (opts !== void 0 && {}.toString.call(opts) !== "[object Object]")
    throw new Error(`Wrong object type for transaction options: ${opts}`);
  const _opts = {
    ...opts,
    // Defaults
    version: def(opts.version, DEFAULT_VERSION),
    lockTime: def(opts.lockTime, 0),
    PSBTVersion: def(opts.PSBTVersion, 0)
  };
  if (typeof _opts.allowUnknowInput !== "undefined")
    opts.allowUnknownInputs = _opts.allowUnknowInput;
  if (typeof _opts.allowUnknowOutput !== "undefined")
    opts.allowUnknownOutputs = _opts.allowUnknowOutput;
  if (typeof _opts.lockTime !== "number")
    throw new Error("Transaction lock time should be number");
  U32LE.encode(_opts.lockTime);
  if (_opts.PSBTVersion !== 0 && _opts.PSBTVersion !== 2)
    throw new Error(`Unknown PSBT version ${_opts.PSBTVersion}`);
  for (const k of [
    "allowUnknownVersion",
    "allowUnknownOutputs",
    "allowUnknownInputs",
    "disableScriptCheck",
    "bip174jsCompat",
    "allowLegacyWitnessUtxo",
    "lowR"
  ]) {
    const v = _opts[k];
    if (v === void 0)
      continue;
    if (typeof v !== "boolean")
      throw new Error(`Transation options wrong type: ${k}=${v} (${typeof v})`);
  }
  if (_opts.allowUnknownVersion ? typeof _opts.version === "number" : ![-1, 0, 1, 2, 3].includes(_opts.version))
    throw new Error(`Unknown version: ${_opts.version}`);
  if (_opts.customScripts !== void 0) {
    const cs = _opts.customScripts;
    if (!Array.isArray(cs)) {
      throw new Error(`wrong custom scripts type (expected array): customScripts=${cs} (${typeof cs})`);
    }
    for (const s of cs) {
      if (typeof s.encode !== "function" || typeof s.decode !== "function")
        throw new Error(`wrong script=${s} (${typeof s})`);
      if (s.finalizeTaproot !== void 0 && typeof s.finalizeTaproot !== "function")
        throw new Error(`wrong script=${s} (${typeof s})`);
    }
  }
  return Object.freeze(_opts);
}
function validateInput(i) {
  if (i.nonWitnessUtxo && i.index !== void 0) {
    const last = i.nonWitnessUtxo.outputs.length - 1;
    if (i.index > last)
      throw new Error(`validateInput: index(${i.index}) not in nonWitnessUtxo`);
    const prevOut = i.nonWitnessUtxo.outputs[i.index];
    if (i.witnessUtxo && (!equalBytes2(i.witnessUtxo.script, prevOut.script) || i.witnessUtxo.amount !== prevOut.amount))
      throw new Error("validateInput: witnessUtxo different from nonWitnessUtxo");
    if (i.txid) {
      const outputs = i.nonWitnessUtxo.outputs;
      if (outputs.length - 1 < i.index)
        throw new Error("nonWitnessUtxo: incorect output index");
      const tx = Transaction.fromRaw(RawTx.encode(i.nonWitnessUtxo), {
        allowUnknownOutputs: true,
        disableScriptCheck: true,
        allowUnknownInputs: true
      });
      const txid = hex.encode(i.txid);
      if (tx.isFinal && tx.id !== txid)
        throw new Error(`nonWitnessUtxo: wrong txid, exp=${txid} got=${tx.id}`);
    }
  }
  return i;
}
function getPrevOut(input) {
  if (input.nonWitnessUtxo) {
    if (input.index === void 0)
      throw new Error("Unknown input index");
    return input.nonWitnessUtxo.outputs[input.index];
  } else if (input.witnessUtxo)
    return input.witnessUtxo;
  else
    throw new Error("Cannot find previous output info");
}
function normalizeInput(i, cur, allowedFields, disableScriptCheck = false, allowUnknown = false) {
  let { nonWitnessUtxo, txid } = i;
  if (typeof nonWitnessUtxo === "string")
    nonWitnessUtxo = hex.decode(nonWitnessUtxo);
  if (isBytes4(nonWitnessUtxo))
    nonWitnessUtxo = RawTx.decode(nonWitnessUtxo);
  if (!("nonWitnessUtxo" in i) && nonWitnessUtxo === void 0)
    nonWitnessUtxo = cur?.nonWitnessUtxo;
  if (typeof txid === "string")
    txid = hex.decode(txid);
  if (txid === void 0)
    txid = cur?.txid;
  let res = { ...cur, ...i, nonWitnessUtxo, txid };
  if (!("nonWitnessUtxo" in i) && res.nonWitnessUtxo === void 0)
    delete res.nonWitnessUtxo;
  if (res.sequence === void 0)
    res.sequence = DEFAULT_SEQUENCE;
  if (res.tapMerkleRoot === null)
    delete res.tapMerkleRoot;
  res = mergeKeyMap(PSBTInput, res, cur, allowedFields, allowUnknown);
  PSBTInputCoder.encode(res);
  let prevOut;
  if (res.nonWitnessUtxo && res.index !== void 0)
    prevOut = res.nonWitnessUtxo.outputs[res.index];
  else if (res.witnessUtxo)
    prevOut = res.witnessUtxo;
  if (prevOut && !disableScriptCheck)
    checkScript(prevOut && prevOut.script, res.redeemScript, res.witnessScript);
  return res;
}
function getInputType(input, allowLegacyWitnessUtxo = false) {
  let txType = "legacy";
  let defaultSighash = SignatureHash.ALL;
  const prevOut = getPrevOut(input);
  const first = OutScript.decode(prevOut.script);
  let type = first.type;
  let cur = first;
  const stack = [first];
  if (first.type === "tr") {
    defaultSighash = SignatureHash.DEFAULT;
    return {
      txType: "taproot",
      type: "tr",
      last: first,
      lastScript: prevOut.script,
      defaultSighash,
      sighash: input.sighashType || defaultSighash
    };
  } else {
    if (first.type === "wpkh" || first.type === "wsh")
      txType = "segwit";
    if (first.type === "sh") {
      if (!input.redeemScript)
        throw new Error("inputType: sh without redeemScript");
      let child = OutScript.decode(input.redeemScript);
      if (child.type === "wpkh" || child.type === "wsh")
        txType = "segwit";
      stack.push(child);
      cur = child;
      type += `-${child.type}`;
    }
    if (cur.type === "wsh") {
      if (!input.witnessScript)
        throw new Error("inputType: wsh without witnessScript");
      let child = OutScript.decode(input.witnessScript);
      if (child.type === "wsh")
        txType = "segwit";
      stack.push(child);
      cur = child;
      type += `-${child.type}`;
    }
    const last = stack[stack.length - 1];
    if (last.type === "sh" || last.type === "wsh")
      throw new Error("inputType: sh/wsh cannot be terminal type");
    const lastScript = OutScript.encode(last);
    const res = {
      type,
      txType,
      last,
      lastScript,
      defaultSighash,
      sighash: input.sighashType || defaultSighash
    };
    if (txType === "legacy" && !allowLegacyWitnessUtxo && !input.nonWitnessUtxo) {
      throw new Error(`Transaction/sign: legacy input without nonWitnessUtxo, can result in attack that forces paying higher fees. Pass allowLegacyWitnessUtxo=true, if you sure`);
    }
    return res;
  }
}
var Transaction = class _Transaction {
  constructor(opts = {}) {
    this.global = {};
    this.inputs = [];
    this.outputs = [];
    const _opts = this.opts = validateOpts(opts);
    if (_opts.lockTime !== DEFAULT_LOCKTIME)
      this.global.fallbackLocktime = _opts.lockTime;
    this.global.txVersion = _opts.version;
  }
  // Import
  static fromRaw(raw, opts = {}) {
    const parsed = RawTx.decode(raw);
    const tx = new _Transaction({ ...opts, version: parsed.version, lockTime: parsed.lockTime });
    for (const o of parsed.outputs)
      tx.addOutput(o);
    tx.outputs = parsed.outputs;
    tx.inputs = parsed.inputs;
    if (parsed.witnesses) {
      for (let i = 0; i < parsed.witnesses.length; i++)
        tx.inputs[i].finalScriptWitness = parsed.witnesses[i];
    }
    return tx;
  }
  // PSBT
  static fromPSBT(psbt_, opts = {}) {
    let parsed;
    try {
      parsed = RawPSBTV0.decode(psbt_);
    } catch (e0) {
      try {
        parsed = RawPSBTV2.decode(psbt_);
      } catch (e2) {
        throw e0;
      }
    }
    const PSBTVersion = parsed.global.version || 0;
    if (PSBTVersion !== 0 && PSBTVersion !== 2)
      throw new Error(`Wrong PSBT version=${PSBTVersion}`);
    const unsigned = parsed.global.unsignedTx;
    const version = PSBTVersion === 0 ? unsigned?.version : parsed.global.txVersion;
    const lockTime = PSBTVersion === 0 ? unsigned?.lockTime : parsed.global.fallbackLocktime;
    const tx = new _Transaction({ ...opts, version, lockTime, PSBTVersion });
    const inputCount = PSBTVersion === 0 ? unsigned?.inputs.length : parsed.global.inputCount;
    tx.inputs = parsed.inputs.slice(0, inputCount).map((i, j) => validateInput({
      finalScriptSig: EMPTY,
      ...parsed.global.unsignedTx?.inputs[j],
      ...i
    }));
    const outputCount = PSBTVersion === 0 ? unsigned?.outputs.length : parsed.global.outputCount;
    tx.outputs = parsed.outputs.slice(0, outputCount).map((i, j) => ({
      ...i,
      ...parsed.global.unsignedTx?.outputs[j]
    }));
    tx.global = { ...parsed.global, txVersion: version };
    if (lockTime !== DEFAULT_LOCKTIME)
      tx.global.fallbackLocktime = lockTime;
    return tx;
  }
  toPSBT(PSBTVersion = this.opts.PSBTVersion) {
    if (PSBTVersion !== 0 && PSBTVersion !== 2)
      throw new Error(`Wrong PSBT version=${PSBTVersion}`);
    const inputs = this.inputs.map((i) => validateInput(cleanPSBTFields(PSBTVersion, PSBTInput, i)));
    for (const inp of inputs) {
      if (inp.partialSig && !inp.partialSig.length)
        delete inp.partialSig;
      if (inp.finalScriptSig && !inp.finalScriptSig.length)
        delete inp.finalScriptSig;
      if (inp.finalScriptWitness && !inp.finalScriptWitness.length)
        delete inp.finalScriptWitness;
    }
    const outputs = this.outputs.map((i) => cleanPSBTFields(PSBTVersion, PSBTOutput, i));
    const global = { ...this.global };
    if (PSBTVersion === 0) {
      global.unsignedTx = RawOldTx.decode(RawOldTx.encode({
        version: this.version,
        lockTime: this.lockTime,
        inputs: this.inputs.map(inputBeforeSign).map((i) => ({
          ...i,
          finalScriptSig: EMPTY
        })),
        outputs: this.outputs.map(outputBeforeSign)
      }));
      delete global.fallbackLocktime;
      delete global.txVersion;
    } else {
      global.version = PSBTVersion;
      global.txVersion = this.version;
      global.inputCount = this.inputs.length;
      global.outputCount = this.outputs.length;
      if (global.fallbackLocktime && global.fallbackLocktime === DEFAULT_LOCKTIME)
        delete global.fallbackLocktime;
    }
    if (this.opts.bip174jsCompat) {
      if (!inputs.length)
        inputs.push({});
      if (!outputs.length)
        outputs.push({});
    }
    return (PSBTVersion === 0 ? RawPSBTV0 : RawPSBTV2).encode({
      global,
      inputs,
      outputs
    });
  }
  // BIP370 lockTime (https://github.com/bitcoin/bips/blob/master/bip-0370.mediawiki#determining-lock-time)
  get lockTime() {
    let height = DEFAULT_LOCKTIME;
    let heightCnt = 0;
    let time = DEFAULT_LOCKTIME;
    let timeCnt = 0;
    for (const i of this.inputs) {
      if (i.requiredHeightLocktime) {
        height = Math.max(height, i.requiredHeightLocktime);
        heightCnt++;
      }
      if (i.requiredTimeLocktime) {
        time = Math.max(time, i.requiredTimeLocktime);
        timeCnt++;
      }
    }
    if (heightCnt && heightCnt >= timeCnt)
      return height;
    if (time !== DEFAULT_LOCKTIME)
      return time;
    return this.global.fallbackLocktime || DEFAULT_LOCKTIME;
  }
  get version() {
    if (this.global.txVersion === void 0)
      throw new Error("No global.txVersion");
    return this.global.txVersion;
  }
  inputStatus(idx) {
    this.checkInputIdx(idx);
    const input = this.inputs[idx];
    if (input.finalScriptSig && input.finalScriptSig.length)
      return "finalized";
    if (input.finalScriptWitness && input.finalScriptWitness.length)
      return "finalized";
    if (input.tapKeySig)
      return "signed";
    if (input.tapScriptSig && input.tapScriptSig.length)
      return "signed";
    if (input.partialSig && input.partialSig.length)
      return "signed";
    return "unsigned";
  }
  // Cannot replace unpackSighash, tests rely on very generic implemenetation with signing inputs outside of range
  // We will lose some vectors -> smaller test coverage of preimages (very important!)
  inputSighash(idx) {
    this.checkInputIdx(idx);
    const inputSighash = this.inputs[idx].sighashType;
    const sighash = inputSighash === void 0 ? SignatureHash.DEFAULT : inputSighash;
    const sigOutputs = sighash === SignatureHash.DEFAULT ? SignatureHash.ALL : sighash & 3;
    const sigInputs = sighash & SignatureHash.ANYONECANPAY;
    return { sigInputs, sigOutputs };
  }
  // Very nice for debug purposes, but slow. If there is too much inputs/outputs to add, will be quadratic.
  // Some cache will be nice, but there chance to have bugs with cache invalidation
  signStatus() {
    let addInput = true, addOutput = true;
    let inputs = [], outputs = [];
    for (let idx = 0; idx < this.inputs.length; idx++) {
      const status = this.inputStatus(idx);
      if (status === "unsigned")
        continue;
      const { sigInputs, sigOutputs } = this.inputSighash(idx);
      if (sigInputs === SignatureHash.ANYONECANPAY)
        inputs.push(idx);
      else
        addInput = false;
      if (sigOutputs === SignatureHash.ALL)
        addOutput = false;
      else if (sigOutputs === SignatureHash.SINGLE)
        outputs.push(idx);
      else if (sigOutputs === SignatureHash.NONE) {
      } else
        throw new Error(`Wrong signature hash output type: ${sigOutputs}`);
    }
    return { addInput, addOutput, inputs, outputs };
  }
  get isFinal() {
    for (let idx = 0; idx < this.inputs.length; idx++)
      if (this.inputStatus(idx) !== "finalized")
        return false;
    return true;
  }
  // Info utils
  get hasWitnesses() {
    let out = false;
    for (const i of this.inputs)
      if (i.finalScriptWitness && i.finalScriptWitness.length)
        out = true;
    return out;
  }
  // https://en.bitcoin.it/wiki/Weight_units
  get weight() {
    if (!this.isFinal)
      throw new Error("Transaction is not finalized");
    let out = 32;
    const outputs = this.outputs.map(outputBeforeSign);
    out += 4 * CompactSizeLen.encode(this.outputs.length).length;
    for (const o of outputs)
      out += 32 + 4 * VarBytes.encode(o.script).length;
    if (this.hasWitnesses)
      out += 2;
    out += 4 * CompactSizeLen.encode(this.inputs.length).length;
    for (const i of this.inputs) {
      out += 160 + 4 * VarBytes.encode(i.finalScriptSig || EMPTY).length;
      if (this.hasWitnesses && i.finalScriptWitness)
        out += RawWitness.encode(i.finalScriptWitness).length;
    }
    return out;
  }
  get vsize() {
    return toVsize(this.weight);
  }
  toBytes(withScriptSig = false, withWitness = false) {
    return RawTx.encode({
      version: this.version,
      lockTime: this.lockTime,
      inputs: this.inputs.map(inputBeforeSign).map((i) => ({
        ...i,
        finalScriptSig: withScriptSig && i.finalScriptSig || EMPTY
      })),
      outputs: this.outputs.map(outputBeforeSign),
      witnesses: this.inputs.map((i) => i.finalScriptWitness || []),
      segwitFlag: withWitness && this.hasWitnesses
    });
  }
  get unsignedTx() {
    return this.toBytes(false, false);
  }
  get hex() {
    return hex.encode(this.toBytes(true, this.hasWitnesses));
  }
  get hash() {
    if (!this.isFinal)
      throw new Error("Transaction is not finalized");
    return hex.encode(sha256x2(this.toBytes(true)));
  }
  get id() {
    if (!this.isFinal)
      throw new Error("Transaction is not finalized");
    return hex.encode(sha256x2(this.toBytes(true)).reverse());
  }
  // Input stuff
  checkInputIdx(idx) {
    if (!Number.isSafeInteger(idx) || 0 > idx || idx >= this.inputs.length)
      throw new Error(`Wrong input index=${idx}`);
  }
  getInput(idx) {
    this.checkInputIdx(idx);
    return cloneDeep(this.inputs[idx]);
  }
  get inputsLength() {
    return this.inputs.length;
  }
  // Modification
  addInput(input, _ignoreSignStatus = false) {
    if (!_ignoreSignStatus && !this.signStatus().addInput)
      throw new Error("Tx has signed inputs, cannot add new one");
    this.inputs.push(normalizeInput(input, void 0, void 0, this.opts.disableScriptCheck));
    return this.inputs.length - 1;
  }
  updateInput(idx, input, _ignoreSignStatus = false) {
    this.checkInputIdx(idx);
    let allowedFields = void 0;
    if (!_ignoreSignStatus) {
      const status = this.signStatus();
      if (!status.addInput || status.inputs.includes(idx))
        allowedFields = PSBTInputUnsignedKeys;
    }
    this.inputs[idx] = normalizeInput(input, this.inputs[idx], allowedFields, this.opts.disableScriptCheck, this.opts.allowUnknown);
  }
  // Output stuff
  checkOutputIdx(idx) {
    if (!Number.isSafeInteger(idx) || 0 > idx || idx >= this.outputs.length)
      throw new Error(`Wrong output index=${idx}`);
  }
  getOutput(idx) {
    this.checkOutputIdx(idx);
    return cloneDeep(this.outputs[idx]);
  }
  getOutputAddress(idx, network = NETWORK) {
    const out = this.getOutput(idx);
    if (!out.script)
      return;
    return Address(network).encode(OutScript.decode(out.script));
  }
  get outputsLength() {
    return this.outputs.length;
  }
  normalizeOutput(o, cur, allowedFields) {
    let { amount, script } = o;
    if (amount === void 0)
      amount = cur?.amount;
    if (typeof amount !== "bigint")
      throw new Error(`Wrong amount type, should be of type bigint in sats, but got ${amount} of type ${typeof amount}`);
    if (typeof script === "string")
      script = hex.decode(script);
    if (script === void 0)
      script = cur?.script;
    let res = { ...cur, ...o, amount, script };
    if (res.amount === void 0)
      delete res.amount;
    res = mergeKeyMap(PSBTOutput, res, cur, allowedFields, this.opts.allowUnknown);
    PSBTOutputCoder.encode(res);
    if (res.script && !this.opts.allowUnknownOutputs && OutScript.decode(res.script).type === "unknown") {
      throw new Error("Transaction/output: unknown output script type, there is a chance that input is unspendable. Pass allowUnknownOutputs=true, if you sure");
    }
    if (!this.opts.disableScriptCheck)
      checkScript(res.script, res.redeemScript, res.witnessScript);
    return res;
  }
  addOutput(o, _ignoreSignStatus = false) {
    if (!_ignoreSignStatus && !this.signStatus().addOutput)
      throw new Error("Tx has signed outputs, cannot add new one");
    this.outputs.push(this.normalizeOutput(o));
    return this.outputs.length - 1;
  }
  updateOutput(idx, output, _ignoreSignStatus = false) {
    this.checkOutputIdx(idx);
    let allowedFields = void 0;
    if (!_ignoreSignStatus) {
      const status = this.signStatus();
      if (!status.addOutput || status.outputs.includes(idx))
        allowedFields = PSBTOutputUnsignedKeys;
    }
    this.outputs[idx] = this.normalizeOutput(output, this.outputs[idx], allowedFields);
  }
  addOutputAddress(address, amount, network = NETWORK) {
    return this.addOutput({ script: OutScript.encode(Address(network).decode(address)), amount });
  }
  // Utils
  get fee() {
    let res = 0n;
    for (const i of this.inputs) {
      const prevOut = getPrevOut(i);
      if (!prevOut)
        throw new Error("Empty input amount");
      res += prevOut.amount;
    }
    const outputs = this.outputs.map(outputBeforeSign);
    for (const o of outputs)
      res -= o.amount;
    return res;
  }
  // Signing
  // Based on https://github.com/bitcoin/bitcoin/blob/5871b5b5ab57a0caf9b7514eb162c491c83281d5/test/functional/test_framework/script.py#L624
  // There is optimization opportunity to re-use hashes for multiple inputs for witness v0/v1,
  // but we are trying to be less complicated for audit purpose for now.
  preimageLegacy(idx, prevOutScript, hashType) {
    const { isAny, isNone, isSingle } = unpackSighash(hashType);
    if (idx < 0 || !Number.isSafeInteger(idx))
      throw new Error(`Invalid input idx=${idx}`);
    if (isSingle && idx >= this.outputs.length || idx >= this.inputs.length)
      return U256BE.encode(1n);
    prevOutScript = Script.encode(Script.decode(prevOutScript).filter((i) => i !== "CODESEPARATOR"));
    let inputs = this.inputs.map(inputBeforeSign).map((input, inputIdx) => ({
      ...input,
      finalScriptSig: inputIdx === idx ? prevOutScript : EMPTY
    }));
    if (isAny)
      inputs = [inputs[idx]];
    else if (isNone || isSingle) {
      inputs = inputs.map((input, inputIdx) => ({
        ...input,
        sequence: inputIdx === idx ? input.sequence : 0
      }));
    }
    let outputs = this.outputs.map(outputBeforeSign);
    if (isNone)
      outputs = [];
    else if (isSingle) {
      outputs = outputs.slice(0, idx).fill(EMPTY_OUTPUT).concat([outputs[idx]]);
    }
    const tmpTx = RawTx.encode({
      lockTime: this.lockTime,
      version: this.version,
      segwitFlag: false,
      inputs,
      outputs
    });
    return sha256x2(tmpTx, I32LE.encode(hashType));
  }
  preimageWitnessV0(idx, prevOutScript, hashType, amount) {
    const { isAny, isNone, isSingle } = unpackSighash(hashType);
    let inputHash = EMPTY32;
    let sequenceHash = EMPTY32;
    let outputHash = EMPTY32;
    const inputs = this.inputs.map(inputBeforeSign);
    const outputs = this.outputs.map(outputBeforeSign);
    if (!isAny)
      inputHash = sha256x2(...inputs.map(TxHashIdx.encode));
    if (!isAny && !isSingle && !isNone)
      sequenceHash = sha256x2(...inputs.map((i) => U32LE.encode(i.sequence)));
    if (!isSingle && !isNone) {
      outputHash = sha256x2(...outputs.map(RawOutput.encode));
    } else if (isSingle && idx < outputs.length)
      outputHash = sha256x2(RawOutput.encode(outputs[idx]));
    const input = inputs[idx];
    return sha256x2(I32LE.encode(this.version), inputHash, sequenceHash, createBytes(32, true).encode(input.txid), U32LE.encode(input.index), VarBytes.encode(prevOutScript), U64LE.encode(amount), U32LE.encode(input.sequence), outputHash, U32LE.encode(this.lockTime), U32LE.encode(hashType));
  }
  preimageWitnessV1(idx, prevOutScript, hashType, amount, codeSeparator = -1, leafScript, leafVer = 192, annex) {
    if (!Array.isArray(amount) || this.inputs.length !== amount.length)
      throw new Error(`Invalid amounts array=${amount}`);
    if (!Array.isArray(prevOutScript) || this.inputs.length !== prevOutScript.length)
      throw new Error(`Invalid prevOutScript array=${prevOutScript}`);
    const out = [
      U8.encode(0),
      U8.encode(hashType),
      // U8 sigHash
      I32LE.encode(this.version),
      U32LE.encode(this.lockTime)
    ];
    const outType = hashType === SignatureHash.DEFAULT ? SignatureHash.ALL : hashType & 3;
    const inType = hashType & SignatureHash.ANYONECANPAY;
    const inputs = this.inputs.map(inputBeforeSign);
    const outputs = this.outputs.map(outputBeforeSign);
    if (inType !== SignatureHash.ANYONECANPAY) {
      out.push(...[
        inputs.map(TxHashIdx.encode),
        amount.map(U64LE.encode),
        prevOutScript.map(VarBytes.encode),
        inputs.map((i) => U32LE.encode(i.sequence))
      ].map((i) => sha256(concatBytes3(...i))));
    }
    if (outType === SignatureHash.ALL) {
      out.push(sha256(concatBytes3(...outputs.map(RawOutput.encode))));
    }
    const spendType = (annex ? 1 : 0) | (leafScript ? 2 : 0);
    out.push(new Uint8Array([spendType]));
    if (inType === SignatureHash.ANYONECANPAY) {
      const inp = inputs[idx];
      out.push(TxHashIdx.encode(inp), U64LE.encode(amount[idx]), VarBytes.encode(prevOutScript[idx]), U32LE.encode(inp.sequence));
    } else
      out.push(U32LE.encode(idx));
    if (spendType & 1)
      out.push(sha256(VarBytes.encode(annex || EMPTY)));
    if (outType === SignatureHash.SINGLE)
      out.push(idx < outputs.length ? sha256(RawOutput.encode(outputs[idx])) : EMPTY32);
    if (leafScript)
      out.push(tapLeafHash(leafScript, leafVer), U8.encode(0), I32LE.encode(codeSeparator));
    return tagSchnorr("TapSighash", ...out);
  }
  // Signer can be privateKey OR instance of bip32 HD stuff
  signIdx(privateKey, idx, allowedSighash, _auxRand) {
    this.checkInputIdx(idx);
    const input = this.inputs[idx];
    const inputType = getInputType(input, this.opts.allowLegacyWitnessUtxo);
    if (!isBytes4(privateKey)) {
      if (!input.bip32Derivation || !input.bip32Derivation.length)
        throw new Error("bip32Derivation: empty");
      const signers = input.bip32Derivation.filter((i) => i[1].fingerprint == privateKey.fingerprint).map(([pubKey, { path }]) => {
        let s = privateKey;
        for (const i of path)
          s = s.deriveChild(i);
        if (!equalBytes2(s.publicKey, pubKey))
          throw new Error("bip32Derivation: wrong pubKey");
        if (!s.privateKey)
          throw new Error("bip32Derivation: no privateKey");
        return s;
      });
      if (!signers.length)
        throw new Error(`bip32Derivation: no items with fingerprint=${privateKey.fingerprint}`);
      let signed = false;
      for (const s of signers)
        if (this.signIdx(s.privateKey, idx))
          signed = true;
      return signed;
    }
    if (!allowedSighash)
      allowedSighash = [inputType.defaultSighash];
    else
      allowedSighash.forEach(validateSigHash);
    const sighash = inputType.sighash;
    if (!allowedSighash.includes(sighash)) {
      throw new Error(`Input with not allowed sigHash=${sighash}. Allowed: ${allowedSighash.join(", ")}`);
    }
    const { sigOutputs } = this.inputSighash(idx);
    if (sigOutputs === SignatureHash.SINGLE && idx >= this.outputs.length) {
      throw new Error(`Input with sighash SINGLE, but there is no output with corresponding index=${idx}`);
    }
    const prevOut = getPrevOut(input);
    if (inputType.txType === "taproot") {
      const prevOuts = this.inputs.map(getPrevOut);
      const prevOutScript = prevOuts.map((i) => i.script);
      const amount = prevOuts.map((i) => i.amount);
      let signed = false;
      let schnorrPub = pubSchnorr(privateKey);
      let merkleRoot = input.tapMerkleRoot || EMPTY;
      if (input.tapInternalKey) {
        const { pubKey, privKey } = getTaprootKeys(privateKey, schnorrPub, input.tapInternalKey, merkleRoot);
        const [taprootPubKey, _] = taprootTweakPubkey(input.tapInternalKey, merkleRoot);
        if (equalBytes2(taprootPubKey, pubKey)) {
          const hash = this.preimageWitnessV1(idx, prevOutScript, sighash, amount);
          const sig = concatBytes3(signSchnorr(hash, privKey, _auxRand), sighash !== SignatureHash.DEFAULT ? new Uint8Array([sighash]) : EMPTY);
          this.updateInput(idx, { tapKeySig: sig }, true);
          signed = true;
        }
      }
      if (input.tapLeafScript) {
        input.tapScriptSig = input.tapScriptSig || [];
        for (const [_, _script] of input.tapLeafScript) {
          const script = _script.subarray(0, -1);
          const scriptDecoded = Script.decode(script);
          const ver = _script[_script.length - 1];
          const hash = tapLeafHash(script, ver);
          const pos = scriptDecoded.findIndex((i) => isBytes4(i) && equalBytes2(i, schnorrPub));
          if (pos === -1)
            continue;
          const msg = this.preimageWitnessV1(idx, prevOutScript, sighash, amount, void 0, script, ver);
          const sig = concatBytes3(signSchnorr(msg, privateKey, _auxRand), sighash !== SignatureHash.DEFAULT ? new Uint8Array([sighash]) : EMPTY);
          this.updateInput(idx, { tapScriptSig: [[{ pubKey: schnorrPub, leafHash: hash }, sig]] }, true);
          signed = true;
        }
      }
      if (!signed)
        throw new Error("No taproot scripts signed");
      return true;
    } else {
      const pubKey = pubECDSA(privateKey);
      let hasPubkey = false;
      const pubKeyHash = hash1602(pubKey);
      for (const i of Script.decode(inputType.lastScript)) {
        if (isBytes4(i) && (equalBytes2(i, pubKey) || equalBytes2(i, pubKeyHash)))
          hasPubkey = true;
      }
      if (!hasPubkey)
        throw new Error(`Input script doesn't have pubKey: ${inputType.lastScript}`);
      let hash;
      if (inputType.txType === "legacy") {
        hash = this.preimageLegacy(idx, inputType.lastScript, sighash);
      } else if (inputType.txType === "segwit") {
        let script = inputType.lastScript;
        if (inputType.last.type === "wpkh")
          script = OutScript.encode({ type: "pkh", hash: inputType.last.hash });
        hash = this.preimageWitnessV0(idx, script, sighash, prevOut.amount);
      } else
        throw new Error(`Transaction/sign: unknown tx type: ${inputType.txType}`);
      const sig = signECDSA(hash, privateKey, this.opts.lowR);
      this.updateInput(idx, {
        partialSig: [[pubKey, concatBytes3(sig, new Uint8Array([sighash]))]]
      }, true);
    }
    return true;
  }
  // This is bad API. Will work if user creates and signs tx, but if
  // there is some complex workflow with exchanging PSBT and signing them,
  // then it is better to validate which output user signs. How could a better API look like?
  // Example: user adds input, sends to another party, then signs received input (mixer etc),
  // another user can add different input for same key and user will sign it.
  // Even worse: another user can add bip32 derivation, and spend money from different address.
  // Better api: signIdx
  sign(privateKey, allowedSighash, _auxRand) {
    let num2 = 0;
    for (let i = 0; i < this.inputs.length; i++) {
      try {
        if (this.signIdx(privateKey, i, allowedSighash, _auxRand))
          num2++;
      } catch (e) {
      }
    }
    if (!num2)
      throw new Error("No inputs signed");
    return num2;
  }
  finalizeIdx(idx) {
    this.checkInputIdx(idx);
    if (this.fee < 0n)
      throw new Error("Outputs spends more than inputs amount");
    const input = this.inputs[idx];
    const inputType = getInputType(input, this.opts.allowLegacyWitnessUtxo);
    if (inputType.txType === "taproot") {
      if (input.tapKeySig)
        input.finalScriptWitness = [input.tapKeySig];
      else if (input.tapLeafScript && input.tapScriptSig) {
        const leafs = input.tapLeafScript.sort((a, b) => TaprootControlBlock.encode(a[0]).length - TaprootControlBlock.encode(b[0]).length);
        for (const [cb, _script] of leafs) {
          const script = _script.slice(0, -1);
          const ver = _script[_script.length - 1];
          const outScript = OutScript.decode(script);
          const hash = tapLeafHash(script, ver);
          const scriptSig = input.tapScriptSig.filter((i) => equalBytes2(i[0].leafHash, hash));
          let signatures = [];
          if (outScript.type === "tr_ms") {
            const m = outScript.m;
            const pubkeys = outScript.pubkeys;
            let added = 0;
            for (const pub of pubkeys) {
              const sigIdx = scriptSig.findIndex((i) => equalBytes2(i[0].pubKey, pub));
              if (added === m || sigIdx === -1) {
                signatures.push(EMPTY);
                continue;
              }
              signatures.push(scriptSig[sigIdx][1]);
              added++;
            }
            if (added !== m)
              continue;
          } else if (outScript.type === "tr_ns") {
            for (const pub of outScript.pubkeys) {
              const sigIdx = scriptSig.findIndex((i) => equalBytes2(i[0].pubKey, pub));
              if (sigIdx === -1)
                continue;
              signatures.push(scriptSig[sigIdx][1]);
            }
            if (signatures.length !== outScript.pubkeys.length)
              continue;
          } else if (outScript.type === "unknown" && this.opts.allowUnknownInputs) {
            const scriptDecoded = Script.decode(script);
            signatures = scriptSig.map(([{ pubKey }, signature]) => {
              const pos = scriptDecoded.findIndex((i) => isBytes4(i) && equalBytes2(i, pubKey));
              if (pos === -1)
                throw new Error("finalize/taproot: cannot find position of pubkey in script");
              return { signature, pos };
            }).sort((a, b) => a.pos - b.pos).map((i) => i.signature);
            if (!signatures.length)
              continue;
          } else {
            const custom = this.opts.customScripts;
            if (custom) {
              for (const c of custom) {
                if (!c.finalizeTaproot)
                  continue;
                const scriptDecoded = Script.decode(script);
                const csEncoded = c.encode(scriptDecoded);
                if (csEncoded === void 0)
                  continue;
                const finalized = c.finalizeTaproot(script, csEncoded, scriptSig);
                if (!finalized)
                  continue;
                input.finalScriptWitness = finalized.concat(TaprootControlBlock.encode(cb));
                input.finalScriptSig = EMPTY;
                cleanFinalInput(input);
                return;
              }
            }
            throw new Error("Finalize: Unknown tapLeafScript");
          }
          input.finalScriptWitness = signatures.reverse().concat([script, TaprootControlBlock.encode(cb)]);
          break;
        }
        if (!input.finalScriptWitness)
          throw new Error("finalize/taproot: empty witness");
      } else
        throw new Error("finalize/taproot: unknown input");
      input.finalScriptSig = EMPTY;
      cleanFinalInput(input);
      return;
    }
    if (!input.partialSig || !input.partialSig.length)
      throw new Error("Not enough partial sign");
    let inputScript = EMPTY;
    let witness = [];
    if (inputType.last.type === "ms") {
      const m = inputType.last.m;
      const pubkeys = inputType.last.pubkeys;
      let signatures = [];
      for (const pub of pubkeys) {
        const sign = input.partialSig.find((s) => equalBytes2(pub, s[0]));
        if (!sign)
          continue;
        signatures.push(sign[1]);
      }
      signatures = signatures.slice(0, m);
      if (signatures.length !== m) {
        throw new Error(`Multisig: wrong signatures count, m=${m} n=${pubkeys.length} signatures=${signatures.length}`);
      }
      inputScript = Script.encode([0, ...signatures]);
    } else if (inputType.last.type === "pk") {
      inputScript = Script.encode([input.partialSig[0][1]]);
    } else if (inputType.last.type === "pkh") {
      inputScript = Script.encode([input.partialSig[0][1], input.partialSig[0][0]]);
    } else if (inputType.last.type === "wpkh") {
      inputScript = EMPTY;
      witness = [input.partialSig[0][1], input.partialSig[0][0]];
    } else if (inputType.last.type === "unknown" && !this.opts.allowUnknownInputs)
      throw new Error("Unknown inputs not allowed");
    let finalScriptSig, finalScriptWitness;
    if (inputType.type.includes("wsh-")) {
      if (inputScript.length && inputType.lastScript.length) {
        witness = Script.decode(inputScript).map((i) => {
          if (i === 0)
            return EMPTY;
          if (isBytes4(i))
            return i;
          throw new Error(`Wrong witness op=${i}`);
        });
      }
      witness = witness.concat(inputType.lastScript);
    }
    if (inputType.txType === "segwit")
      finalScriptWitness = witness;
    if (inputType.type.startsWith("sh-wsh-")) {
      finalScriptSig = Script.encode([Script.encode([0, sha256(inputType.lastScript)])]);
    } else if (inputType.type.startsWith("sh-")) {
      finalScriptSig = Script.encode([...Script.decode(inputScript), inputType.lastScript]);
    } else if (inputType.type.startsWith("wsh-")) {
    } else if (inputType.txType !== "segwit")
      finalScriptSig = inputScript;
    if (!finalScriptSig && !finalScriptWitness)
      throw new Error("Unknown error finalizing input");
    if (finalScriptSig)
      input.finalScriptSig = finalScriptSig;
    if (finalScriptWitness)
      input.finalScriptWitness = finalScriptWitness;
    cleanFinalInput(input);
  }
  finalize() {
    for (let i = 0; i < this.inputs.length; i++)
      this.finalizeIdx(i);
  }
  extract() {
    if (!this.isFinal)
      throw new Error("Transaction has unfinalized inputs");
    if (!this.outputs.length)
      throw new Error("Transaction has no outputs");
    if (this.fee < 0n)
      throw new Error("Outputs spends more than inputs amount");
    return this.toBytes(true, true);
  }
  combine(other) {
    for (const k of ["PSBTVersion", "version", "lockTime"]) {
      if (this.opts[k] !== other.opts[k]) {
        throw new Error(`Transaction/combine: different ${k} this=${this.opts[k]} other=${other.opts[k]}`);
      }
    }
    for (const k of ["inputs", "outputs"]) {
      if (this[k].length !== other[k].length) {
        throw new Error(`Transaction/combine: different ${k} length this=${this[k].length} other=${other[k].length}`);
      }
    }
    const thisUnsigned = this.global.unsignedTx ? RawOldTx.encode(this.global.unsignedTx) : EMPTY;
    const otherUnsigned = other.global.unsignedTx ? RawOldTx.encode(other.global.unsignedTx) : EMPTY;
    if (!equalBytes2(thisUnsigned, otherUnsigned))
      throw new Error(`Transaction/combine: different unsigned tx`);
    this.global = mergeKeyMap(PSBTGlobal, this.global, other.global, void 0, this.opts.allowUnknown);
    for (let i = 0; i < this.inputs.length; i++)
      this.updateInput(i, other.inputs[i], true);
    for (let i = 0; i < this.outputs.length; i++)
      this.updateOutput(i, other.outputs[i], true);
    return this;
  }
  clone() {
    return _Transaction.fromPSBT(this.toPSBT(this.opts.PSBTVersion), this.opts);
  }
};
function PSBTCombine(psbts) {
  if (!psbts || !Array.isArray(psbts) || !psbts.length)
    throw new Error("PSBTCombine: wrong PSBT list");
  const tx = Transaction.fromPSBT(psbts[0]);
  for (let i = 1; i < psbts.length; i++)
    tx.combine(Transaction.fromPSBT(psbts[i]));
  return tx.toPSBT();
}
var HARDENED_OFFSET2 = 2147483648;
function bip32Path(path) {
  const out = [];
  if (!/^[mM]'?/.test(path))
    throw new Error('Path must start with "m" or "M"');
  if (/^[mM]'?$/.test(path))
    return out;
  const parts = path.replace(/^[mM]'?\//, "").split("/");
  for (const c of parts) {
    const m = /^(\d+)('?)$/.exec(c);
    if (!m || m.length !== 3)
      throw new Error(`Invalid child index: ${c}`);
    let idx = +m[1];
    if (!Number.isSafeInteger(idx) || idx >= HARDENED_OFFSET2)
      throw new Error("Invalid index");
    if (m[2] === "'")
      idx += HARDENED_OFFSET2;
    out.push(idx);
  }
  return out;
}

// node_modules/@scure/btc-signer/esm/utxo.js
var encodeTapBlock = (item) => TaprootControlBlock.encode(item);
function iterLeafs(tapLeafScript, sigSize, customScripts) {
  if (!tapLeafScript || !tapLeafScript.length)
    throw new Error("no leafs");
  const empty = () => new Uint8Array(sigSize);
  const leafs = tapLeafScript.sort((a, b) => encodeTapBlock(a[0]).length - encodeTapBlock(b[0]).length);
  for (const [cb, _script] of leafs) {
    const script = _script.slice(0, -1);
    const ver = _script[_script.length - 1];
    const outs = OutScript.decode(script);
    let signatures = [];
    if (outs.type === "tr_ms") {
      const m = outs.m;
      const n = outs.pubkeys.length - m;
      for (let i = 0; i < m; i++)
        signatures.push(empty());
      for (let i = 0; i < n; i++)
        signatures.push(EMPTY);
    } else if (outs.type === "tr_ns") {
      for (const _pub of outs.pubkeys)
        signatures.push(empty());
    } else {
      if (!customScripts)
        throw new Error("Finalize: Unknown tapLeafScript");
      const leafHash = tapLeafHash(script, ver);
      for (const c of customScripts) {
        if (!c.finalizeTaproot)
          continue;
        const scriptDecoded = Script.decode(script);
        const csEncoded = c.encode(scriptDecoded);
        if (csEncoded === void 0)
          continue;
        const pubKeys = scriptDecoded.filter((i) => {
          if (!isBytes4(i))
            return false;
          try {
            validatePubkey(i, PubT.schnorr);
            return true;
          } catch (e) {
            return false;
          }
        });
        const finalized = c.finalizeTaproot(script, csEncoded, pubKeys.map((pubKey) => [{ pubKey, leafHash }, empty()]));
        if (!finalized)
          continue;
        return finalized.concat(encodeTapBlock(cb));
      }
    }
    return signatures.reverse().concat([script, encodeTapBlock(cb)]);
  }
  throw new Error("there was no witness");
}
function estimateInput(inputType, input, opts) {
  let script = EMPTY;
  let witness;
  if (inputType.txType === "taproot") {
    const SCHNORR_SIG_SIZE = inputType.sighash !== SignatureHash.DEFAULT ? 65 : 64;
    if (input.tapInternalKey && !equalBytes2(input.tapInternalKey, TAPROOT_UNSPENDABLE_KEY)) {
      witness = [new Uint8Array(SCHNORR_SIG_SIZE)];
    } else if (input.tapLeafScript) {
      witness = iterLeafs(input.tapLeafScript, SCHNORR_SIG_SIZE, opts.customScripts);
    } else
      throw new Error("estimateInput/taproot: unknown input");
  } else {
    const empty = () => new Uint8Array(72);
    const emptyPub = () => new Uint8Array(33);
    let inputScript = EMPTY;
    let inputWitness = [];
    const ltype = inputType.last.type;
    if (ltype === "ms") {
      const m = inputType.last.m;
      const sig = [0];
      for (let i = 0; i < m; i++)
        sig.push(empty());
      inputScript = Script.encode(sig);
    } else if (ltype === "pk") {
      inputScript = Script.encode([empty()]);
    } else if (ltype === "pkh") {
      inputScript = Script.encode([empty(), emptyPub()]);
    } else if (ltype === "wpkh") {
      inputScript = EMPTY;
      inputWitness = [empty(), emptyPub()];
    } else if (ltype === "unknown" && !opts.allowUnknownInputs)
      throw new Error("Unknown inputs are not allowed");
    if (inputType.type.includes("wsh-")) {
      if (inputScript.length && inputType.lastScript.length) {
        inputWitness = Script.decode(inputScript).map((i) => {
          if (i === 0)
            return EMPTY;
          if (isBytes4(i))
            return i;
          throw new Error(`Wrong witness op=${i}`);
        });
      }
      inputWitness = inputWitness.concat(inputType.lastScript);
    }
    if (inputType.txType === "segwit")
      witness = inputWitness;
    if (inputType.type.startsWith("sh-wsh-")) {
      script = Script.encode([Script.encode([0, new Uint8Array(sha256.outputLen)])]);
    } else if (inputType.type.startsWith("sh-")) {
      script = Script.encode([...Script.decode(inputScript), inputType.lastScript]);
    } else if (inputType.type.startsWith("wsh-")) {
    } else if (inputType.txType !== "segwit")
      script = inputScript;
  }
  let weight = 160 + 4 * VarBytes.encode(script).length;
  let hasWitnesses = false;
  if (witness) {
    weight += RawWitness.encode(witness).length;
    hasWitnesses = true;
  }
  return { weight, hasWitnesses };
}
var _cmpBig = (a, b) => {
  const n = a - b;
  if (n < 0n)
    return -1;
  else if (n > 0n)
    return 1;
  return 0;
};
function getScript(o, opts = {}, network = NETWORK) {
  let script;
  if ("script" in o && isBytes4(o.script)) {
    script = o.script;
  }
  if ("address" in o) {
    if (typeof o.address !== "string")
      throw new Error(`Estimator: wrong output address=${o.address}`);
    script = OutScript.encode(Address(network).decode(o.address));
  }
  if (!script)
    throw new Error("Estimator: wrong output script");
  if (typeof o.amount !== "bigint")
    throw new Error(`Estimator: wrong output amount=${o.amount}, should be of type bigint but got ${typeof o.amount}.`);
  if (script && !opts.allowUnknownOutputs && OutScript.decode(script).type === "unknown") {
    throw new Error("Estimator: unknown output script type, there is a chance that input is unspendable. Pass allowUnknownOutputs=true, if you sure");
  }
  if (!opts.disableScriptCheck)
    checkScript(script);
  return script;
}
var _Estimator = class {
  constructor(inputs, outputs, opts) {
    this.requiredIndices = [];
    this.outputs = outputs;
    this.opts = opts;
    if (typeof opts.feePerByte !== "bigint")
      throw new Error(`Estimator: wrong feePerByte=${opts.feePerByte}, should be of type bigint but got ${typeof opts.feePerByte}.`);
    const inputsDust = 32 + 4 + 1 + 107 + 4;
    const outputDust = 34;
    const dustBytes = opts.dust === void 0 ? BigInt(inputsDust + outputDust) : opts.dust;
    if (typeof dustBytes !== "bigint") {
      throw new Error(`Estimator: wrong dust=${opts.dust}, should be of type bigint but got ${typeof opts.dust}.`);
    }
    const dustFee = opts.dustRelayFeeRate === void 0 ? 3n : opts.dustRelayFeeRate;
    if (typeof dustFee !== "bigint") {
      throw new Error(`Estimator: wrong dustRelayFeeRate=${opts.dustRelayFeeRate}, should be of type bigint but got ${typeof opts.dustRelayFeeRate}.`);
    }
    this.dust = dustBytes * dustFee;
    if (opts.requiredInputs !== void 0 && !Array.isArray(opts.requiredInputs))
      throw new Error(`Estimator: wrong required inputs=${opts.requiredInputs}`);
    const network = opts.network || NETWORK;
    let amount = 0n;
    let baseWeight = 32;
    for (const o of outputs) {
      const script = getScript(o, opts, opts.network);
      baseWeight += 32 + 4 * VarBytes.encode(script).length;
      amount += o.amount;
    }
    if (typeof opts.changeAddress !== "string")
      throw new Error(`Estimator: wrong change address=${opts.changeAddress}`);
    let changeWeight = baseWeight + 32 + 4 * VarBytes.encode(OutScript.encode(Address(network).decode(opts.changeAddress))).length;
    baseWeight += 4 * CompactSizeLen.encode(outputs.length).length;
    changeWeight += 4 * CompactSizeLen.encode(outputs.length + 1).length;
    this.baseWeight = baseWeight;
    this.changeWeight = changeWeight;
    this.amount = amount;
    const allInputs = Array.from(inputs);
    if (opts.requiredInputs) {
      for (let i = 0; i < opts.requiredInputs.length; i++)
        this.requiredIndices.push(allInputs.push(opts.requiredInputs[i]) - 1);
    }
    const inputKeys = /* @__PURE__ */ new Set();
    this.normalizedInputs = allInputs.map((i) => {
      const normalized = normalizeInput(i, void 0, void 0, opts.disableScriptCheck, opts.allowUnknown);
      inputBeforeSign(normalized);
      const key = `${hex.encode(normalized.txid)}:${normalized.index}`;
      if (!opts.allowSameUtxo && inputKeys.has(key))
        throw new Error(`Estimator: same input passed multiple times: ${key}`);
      inputKeys.add(key);
      const inputType = getInputType(normalized, opts.allowLegacyWitnessUtxo);
      const prev = getPrevOut(normalized);
      const estimate = estimateInput(inputType, normalized, this.opts);
      const value = prev.amount - opts.feePerByte * BigInt(toVsize(estimate.weight));
      return { inputType, normalized, amount: prev.amount, value, estimate };
    });
  }
  checkInputIdx(idx) {
    if (!Number.isSafeInteger(idx) || 0 > idx || idx >= this.normalizedInputs.length)
      throw new Error(`Wrong input index=${idx}`);
    return idx;
  }
  sortIndices(indices) {
    return indices.slice().sort((a, b) => {
      const ai = this.normalizedInputs[this.checkInputIdx(a)];
      const bi = this.normalizedInputs[this.checkInputIdx(b)];
      const out = compareBytes(ai.normalized.txid, bi.normalized.txid);
      if (out !== 0)
        return out;
      return ai.normalized.index - bi.normalized.index;
    });
  }
  sortOutputs(outputs) {
    const scripts = outputs.map((o) => getScript(o, this.opts, this.opts.network));
    const indices = outputs.map((_, j) => j);
    return indices.sort((a, b) => {
      const aa = outputs[a].amount;
      const ba = outputs[b].amount;
      const out = _cmpBig(aa, ba);
      if (out !== 0)
        return out;
      return compareBytes(scripts[a], scripts[b]);
    });
  }
  getSatoshi(weigth) {
    return this.opts.feePerByte * BigInt(toVsize(weigth));
  }
  // Sort by value instead of amount
  get biggest() {
    return this.normalizedInputs.map((_i, j) => j).sort((a, b) => _cmpBig(this.normalizedInputs[b].value, this.normalizedInputs[a].value));
  }
  get smallest() {
    return this.biggest.reverse();
  }
  // These assume that UTXO array has historical order.
  // Otherwise, we have no way to know which tx is oldest
  // Explorers usually give UTXO in this order.
  get oldest() {
    return this.normalizedInputs.map((_i, j) => j);
  }
  get newest() {
    return this.oldest.reverse();
  }
  // exact - like blackjack from coinselect.
  // exact(biggest) will select one big utxo which is closer to targetValue+dust, if possible.
  // If not, it will accumulate largest utxo until value is close to targetValue+dust.
  accumulate(indices, exact = false, skipNegative = true, all = false) {
    let weight = this.opts.alwaysChange ? this.changeWeight : this.baseWeight;
    let hasWitnesses = false;
    let num2 = 0;
    let inputsAmount = 0n;
    const targetAmount = this.amount;
    const res = /* @__PURE__ */ new Set();
    let fee;
    for (const idx of this.requiredIndices) {
      this.checkInputIdx(idx);
      if (res.has(idx))
        throw new Error("required input encountered multiple times");
      const { estimate, amount } = this.normalizedInputs[idx];
      let newWeight = weight + estimate.weight;
      if (!hasWitnesses && estimate.hasWitnesses)
        newWeight += 2;
      const totalWeight = newWeight + 4 * CompactSizeLen.encode(num2).length;
      fee = this.getSatoshi(totalWeight);
      weight = newWeight;
      if (estimate.hasWitnesses)
        hasWitnesses = true;
      num2++;
      inputsAmount += amount;
      res.add(idx);
      if (!all && targetAmount + fee <= inputsAmount && num2 >= this.requiredIndices.length)
        return { indices: Array.from(res), fee, weight: totalWeight, total: inputsAmount };
    }
    for (const idx of indices) {
      this.checkInputIdx(idx);
      if (res.has(idx))
        continue;
      const { estimate, amount, value } = this.normalizedInputs[idx];
      let newWeight = weight + estimate.weight;
      if (!hasWitnesses && estimate.hasWitnesses)
        newWeight += 2;
      const totalWeight = newWeight + 4 * CompactSizeLen.encode(num2).length;
      fee = this.getSatoshi(totalWeight);
      if (exact && amount + inputsAmount > targetAmount + fee + this.dust)
        continue;
      if (skipNegative && value <= 0n)
        continue;
      weight = newWeight;
      if (estimate.hasWitnesses)
        hasWitnesses = true;
      num2++;
      inputsAmount += amount;
      res.add(idx);
      if (!all && targetAmount + fee <= inputsAmount)
        return { indices: Array.from(res), fee, weight: totalWeight, total: inputsAmount };
    }
    if (all) {
      const newWeight = weight + 4 * CompactSizeLen.encode(num2).length;
      return { indices: Array.from(res), fee, weight: newWeight, total: inputsAmount };
    }
    return void 0;
  }
  // Works like coinselect default method
  default() {
    const { biggest } = this;
    const exact = this.accumulate(biggest, true, false);
    if (exact)
      return exact;
    return this.accumulate(biggest);
  }
  select(strategy) {
    if (strategy === "all") {
      return this.accumulate(this.normalizedInputs.map((_, j) => j), false, true, true);
    }
    if (strategy === "default")
      return this.default();
    const data = {
      Oldest: () => this.oldest,
      Newest: () => this.newest,
      Smallest: () => this.smallest,
      Biggest: () => this.biggest
    };
    if (strategy.startsWith("exact")) {
      const [exactData, left] = strategy.slice(5).split("/");
      if (!data[exactData])
        throw new Error(`Estimator.select: wrong strategy=${strategy}`);
      strategy = left;
      const exact = this.accumulate(data[exactData](), true, true);
      if (exact)
        return exact;
    }
    if (strategy.startsWith("accum")) {
      const accumData = strategy.slice(5);
      if (!data[accumData])
        throw new Error(`Estimator.select: wrong strategy=${strategy}`);
      return this.accumulate(data[accumData]());
    }
    throw new Error(`Estimator.select: wrong strategy=${strategy}`);
  }
  result(strategy) {
    const s = this.select(strategy);
    if (!s)
      return;
    const { indices, weight, total } = s;
    let needChange = this.opts.alwaysChange;
    const changeWeight = this.opts.alwaysChange ? weight : weight + (this.changeWeight - this.baseWeight);
    const changeFee = this.getSatoshi(changeWeight);
    let fee = s.fee;
    const change = total - this.amount - changeFee;
    if (change > this.dust)
      needChange = true;
    let inputs = indices;
    let outputs = Array.from(this.outputs);
    if (needChange) {
      fee = changeFee;
      if (change < 0n)
        throw new Error(`Estimator.result: negative change=${change}`);
      outputs.push({ address: this.opts.changeAddress, amount: change });
    }
    if (this.opts.bip69) {
      inputs = this.sortIndices(inputs);
      outputs = this.sortOutputs(outputs).map((i) => outputs[i]);
    }
    const res = {
      inputs: inputs.map((i) => this.normalizedInputs[i].normalized),
      outputs,
      fee,
      weight: this.opts.alwaysChange ? s.weight : changeWeight,
      change: !!needChange
    };
    let tx;
    if (this.opts.createTx) {
      const { inputs: inputs2, outputs: outputs2 } = res;
      tx = new Transaction(this.opts);
      for (const i of inputs2)
        tx.addInput(i);
      for (const o of outputs2)
        tx.addOutput({ ...o, script: getScript(o, this.opts, this.opts.network) });
    }
    return Object.assign(res, { tx });
  }
};
function selectUTXO(inputs, outputs, strategy, opts) {
  const _opts = { createTx: true, bip69: true, ...opts };
  const est = new _Estimator(inputs, outputs, _opts);
  return est.result(strategy);
}

// node_modules/@scure/btc-signer/esm/index.js
var utils3 = {
  isBytes: isBytes4,
  concatBytes: concatBytes3,
  compareBytes,
  pubSchnorr,
  randomPrivateKeyBytes,
  taprootTweakPubkey
};

// entry.mjs
var import_qrcode_generator = __toESM(require_qrcode(), 1);
var export_qrcodegen = import_qrcode_generator.default;
export {
  HDKey,
  argon2id,
  base58,
  base58check,
  base64,
  bech32,
  bech32m,
  esm_exports as bip39,
  esm_exports3 as btc,
  bytesToHex,
  concatBytes,
  ed25519,
  hex,
  hexToBytes,
  hmac,
  keccak_256,
  pbkdf2,
  export_qrcodegen as qrcodegen,
  randomBytes,
  ripemd160,
  secp256k1,
  sha256,
  sha512,
  utf8ToBytes,
  wordlist as wordlistEnglish
};
