// MPFR oracle for the float verbs of @term/base (spec.md section 5).
//
// Usage: oracle <verb>   reads one input per line on stdin, as 16 hex digits
// of binary64 bits (two such words, space separated, for the binary verbs
// arc-tangent-of, hypotenuse and power) and prints the correctly rounded
// (round to nearest, ties to even) result as 16 hex digits.
//
// The result is computed at 53 bits in an exponent range of -1073 .. 1024 and
// then subnormalized, so subnormal results are rounded once, at the right place.
// Every NaN result prints the canonical quiet NaN 7ff8000000000000.

#include <mpfr.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int (*unary_fn)(mpfr_t, const mpfr_t, mpfr_rnd_t);
typedef int (*binary_fn)(mpfr_t, const mpfr_t, const mpfr_t, mpfr_rnd_t);

struct unary_row {
  const char *verb;
  unary_fn fn;
};

struct binary_row {
  const char *verb;
  binary_fn fn;
};

static const struct unary_row unary_rows[] = {
  {"exponent", mpfr_exp},
  {"natural-logarithm", mpfr_log},
  {"logarithm-2", mpfr_log2},
  {"logarithm-10", mpfr_log10},
  {"sine", mpfr_sin},
  {"cosine", mpfr_cos},
  {"tangent", mpfr_tan},
  {"arc-sine", mpfr_asin},
  {"arc-cosine", mpfr_acos},
  {"arc-tangent", mpfr_atan},
  {"hyperbolic-sine", mpfr_sinh},
  {"hyperbolic-cosine", mpfr_cosh},
  {"hyperbolic-tangent", mpfr_tanh},
  {NULL, NULL},
};

static const struct binary_row binary_rows[] = {
  {"arc-tangent-of", mpfr_atan2},
  {"hypotenuse", mpfr_hypot},
  {"power", mpfr_pow},
  {NULL, NULL},
};

static double bits_to_double(uint64_t bits) {
  double value;
  memcpy(&value, &bits, sizeof value);
  return value;
}

static uint64_t double_to_bits(double value) {
  uint64_t bits;
  memcpy(&bits, &value, sizeof bits);
  return bits;
}

static void finish(mpfr_t result, int ternary) {
  ternary = mpfr_check_range(result, ternary, MPFR_RNDN);
  mpfr_subnormalize(result, ternary, MPFR_RNDN);
  double out = mpfr_get_d(result, MPFR_RNDN);
  uint64_t bits = mpfr_nan_p(result) ? 0x7ff8000000000000ULL : double_to_bits(out);
  printf("%016llx\n", (unsigned long long)bits);
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: oracle <verb>\n");
    return 2;
  }
  const char *verb = argv[1];
  unary_fn unary = NULL;
  binary_fn binary = NULL;
  for (const struct unary_row *row = unary_rows; row->verb; row++) {
    if (strcmp(row->verb, verb) == 0) unary = row->fn;
  }
  for (const struct binary_row *row = binary_rows; row->verb; row++) {
    if (strcmp(row->verb, verb) == 0) binary = row->fn;
  }
  if (!unary && !binary) {
    fprintf(stderr, "oracle: unknown verb %s\n", verb);
    return 2;
  }

  mpfr_set_emin(-1073);
  mpfr_set_emax(1024);
  mpfr_t a, b, r;
  mpfr_init2(a, 53);
  mpfr_init2(b, 53);
  mpfr_init2(r, 53);

  char line[128];
  while (fgets(line, sizeof line, stdin)) {
    unsigned long long x = 0, y = 0;
    int count = sscanf(line, "%llx %llx", &x, &y);
    if (count < (binary ? 2 : 1)) {
      fprintf(stderr, "oracle: bad line %s", line);
      return 2;
    }
    mpfr_set_d(a, bits_to_double(x), MPFR_RNDN);
    mpfr_clear_flags();
    int ternary;
    if (binary) {
      mpfr_set_d(b, bits_to_double(y), MPFR_RNDN);
      ternary = binary(r, a, b, MPFR_RNDN);
    } else {
      ternary = unary(r, a, MPFR_RNDN);
    }
    finish(r, ternary);
  }
  mpfr_clear(a);
  mpfr_clear(b);
  mpfr_clear(r);
  return 0;
}
