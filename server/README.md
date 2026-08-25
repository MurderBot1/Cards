# LoginServer

A small C++17 TCP server that handles user login and registration.
Built with [premake5](https://premake.github.io/); no other external
dependencies (raw POSIX sockets, no networking or crypto library).

## Layout

```
include/        header files (.h)
src/            implementation files (.cpp)
build/          everything premake5 generates — Makefile + obj/ + bin/
premake5.lua    build configuration
data/           created at runtime: accounts file + log file
```

## Build

Requires premake5 and a C++17 compiler. Builds on both Linux and
Windows — socket differences (Winsock2 vs POSIX BSD sockets) are
isolated behind `PlatformSocket.h`/`.cpp`, and `Logger` picks
`localtime_s`/`localtime_r` per-platform automatically.

**Linux/macOS:**
```bash
premake5 gmake2
make -C build config=debug     # or config=release
```
The binary ends up at `build/bin/Debug/LoginServer` (or `Release`).

**Windows:**
```bat
premake5 vs2022
```
Then open `build/LoginServer.sln` in Visual Studio and build, or from
a Developer Command Prompt:
```bat
msbuild build\LoginServer.sln /p:Configuration=Debug
```
The binary ends up at `build\bin\Debug\LoginServer.exe`.

## Run

```bash
./build/bin/Debug/LoginServer [port] [accounts_file] [log_file]
```

Defaults: port `7777`, accounts file `data/users.db`, log file
`data/server.log`. Press Ctrl+C to stop (handled cleanly via
SIGINT/SIGTERM).

## Protocol

Plain newline-delimited text over TCP:

| Command                            | Response                                                        |
|-------------------------------------|-------------------------------------------------------------------|
| `LOGIN <username> <password>`       | `OK Welcome <username>` or `FAIL Invalid credentials`            |
| `REGISTER <username> <password>`    | `OK Registered <username>` or `FAIL Username taken`               |
| `QUIT`                               | `OK Bye`, then closes the connection                               |

Try it with netcat once the server is running:

```bash
nc localhost 7777
REGISTER alice hunter2
LOGIN alice hunter2
LOGIN alice wrongpassword
QUIT
```

## How credentials are stored

Passwords are never stored in plaintext. `UserStore` generates a
random 128-bit salt per account and stores `SHA-256(salt + password)`
in `data/users.db` (plain pipe-delimited text:
`username|saltHex|hashHex`). SHA-256 is implemented from scratch in
`Sha256.h`/`.cpp` (verified against the standard FIPS test vectors)
purely to keep the project dependency-free — for a real production
system, use a slow, purpose-built password KDF like bcrypt or
argon2 instead of a fast general-purpose hash.

## Concurrency

`Server` accepts connections on a loop and spawns one detached
`std::thread` per client, running a `ClientHandler`. `UserStore` is
protected by a mutex so concurrent logins/registrations from
different clients are safe.