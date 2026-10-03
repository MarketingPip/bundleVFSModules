/* Clang-produced WASI hello-world (v1 gate #4).
 *
 * Unlike the hand-assembled spike (scripts/build-hello-wasi.py), this is
 * real C compiled by wasi-sdk's Clang to wasm32-wasi. It exercises things
 * a hand-assembled module cannot: libc startup, malloc/free, snprintf
 * formatting, and argc/argv handling through args_sizes_get/args_get.
 *
 * Expected stdout with args ["hello.wasm", "foo", "bar"]:
 *   clang-wasi-hello
 *   argc=3
 *   argv[0]=hello.wasm
 *   argv[1]=foo
 *   argv[2]=bar
 *   fib(20)=6765
 */
#include <stdio.h>
#include <stdlib.h>

static int fib(int n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

int main(int argc, char **argv) {
  printf("clang-wasi-hello\n");
  printf("argc=%d\n", argc);
  for (int i = 0; i < argc; i++) {
    printf("argv[%d]=%s\n", i, argv[i]);
  }
  char *buf = malloc(64);
  if (!buf) {
    return 1;
  }
  snprintf(buf, 64, "fib(20)=%d", fib(20));
  printf("%s\n", buf);
  free(buf);
  return 0;
}
