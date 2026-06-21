var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
const CHUNK_SIZE = 65536;
export function hashFile(input) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, e_1, _b, _c;
        const hash = createHash('sha512');
        const stream = createReadStream(input.path, {
            highWaterMark: CHUNK_SIZE,
        });
        try {
            for (var _d = true, stream_1 = __asyncValues(stream), stream_1_1; stream_1_1 = yield stream_1.next(), _a = stream_1_1.done, !_a; _d = true) {
                _c = stream_1_1.value;
                _d = false;
                const chunk = _c;
                hash.update(chunk);
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (!_d && !_a && (_b = stream_1.return)) yield _b.call(stream_1);
            }
            finally { if (e_1) throw e_1.error; }
        }
        return hash.digest('hex');
    });
}
export function hashBuffer(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const hash = createHash('sha512');
        hash.update(input.data);
        return hash.digest('hex');
    });
}
export function hashText(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const hash = createHash('sha512');
        hash.update(input.text, 'utf-8');
        return hash.digest('hex');
    });
}
export function verifyHash(input) {
    const hash = createHash('sha512');
    hash.update(input.data);
    const actual = hash.digest('hex');
    return actual === input.expected;
}
//# sourceMappingURL=hash.js.map