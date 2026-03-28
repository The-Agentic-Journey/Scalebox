# VM Initialization Plan

## Overview

Add support for passing environment variables, files, and an init script during VM creation. These are injected into the VM's rootfs before boot — similar to cloud-init — so VMs start pre-configured without requiring post-boot SSH access.

**Three new optional fields on `CreateVMRequest`:**

1. **`env`** — Key-value pairs written to `~/.ssh/environment`, accessible in all SSH sessions (interactive and non-interactive) and in the init script. Per-user only (not system-wide). `PermitUserEnvironment yes` is set in sshd_config automatically when env vars are provided.
2. **`files`** — Base64-encoded file contents written to specified absolute paths. Owned by `user:user` (UID 1000), mode `640`. Parent directories are created automatically.
3. **`init_script`** — Base64-encoded bash script written to `/opt/scalebox/init.sh` and executed as root on first boot via a one-shot systemd service. The service self-disables and removes the script after execution, ensuring clean snapshots.

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | VM created with `env` has environment variables accessible via non-interactive SSH (`printenv`) | `test/integration.test.ts`: `env vars accessible via non-interactive SSH` |
| 2 | VM created with `files` has files at specified paths with correct content, owner `user:user`, and mode `640` | `test/integration.test.ts`: `files created with correct content and permissions` |
| 3 | VM created with `init_script` executes the script as root on boot | `test/integration.test.ts`: `init script executed on boot` |
| 4 | Init script has access to environment variables passed via `env` | `test/integration.test.ts`: `init script has access to env vars` |
| 5 | Init script service self-disables and removes script after execution | `test/integration.test.ts`: `init script removed after execution` |
| 6 | All three features work together in a single VM creation | `test/integration.test.ts`: `env, files, and init script work together` |
| 7 | Existing VM creation (no new fields) still works identically | Existing tests continue to pass unchanged |

---

## Phase 1: Acceptance Test Scaffolds

### Goal

Create all acceptance tests as skipped stubs. After this phase, `./do check` passes with skipped tests.

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add 6 skipped test stubs in a new `describe("VM Initialization")` block |

Add the following skipped tests inside a new `describe("VM Initialization", ...)` block, placed after the existing `"Phase 5: SSH Access"` tests and before `"Phase 6: Snapshots"`:

```typescript
// === VM Initialization ===
describe("VM Initialization", () => {
	test.skip("env vars accessible via non-interactive SSH", async () => {
		// Criterion #1
	});

	test.skip("files created with correct content and permissions", async () => {
		// Criterion #2
	});

	test.skip("init script executed on boot", async () => {
		// Criterion #3
	});

	test.skip("init script has access to env vars", async () => {
		// Criterion #4
	});

	test.skip("init script removed after execution", async () => {
		// Criterion #5
	});

	test.skip("env, files, and init script work together", async () => {
		// Criterion #6
	});
});
```

**Important:** The `describe("VM Initialization")` block must be nested inside the outer `describe("Firecracker API")` block so it has access to `createdVmIds`, `afterEach` cleanup, and the helpers.

### Verification

- All 6 new tests exist and are skipped
- Run `./do lint` — passes
- Existing tests are unaffected

---

## Phase 2: Consolidate Rootfs Mount Operations

### Goal

Refactor `storage.ts` to replace the separate `injectSshKey()` and `setHostname()` functions with a single `initializeRootfs()` function that mounts the rootfs once, performs all operations, and unmounts once. This is a pure refactor — no new functionality. Existing tests must continue to pass.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/storage.ts` | Modify | Add `initializeRootfs()`, remove `injectSshKey()` and `setHostname()` |
| `src/services/vm.ts` | Modify | Replace `injectSshKey()` + `setHostname()` calls with `initializeRootfs()` |

#### `src/services/storage.ts`

**Add** the following interface and function. Place the interface at the top of the file (after imports), and the function after `copyRootfs()`:

```typescript
export interface InitializeRootfsOptions {
	sshPublicKey: string;
	hostname?: string;
}

export async function initializeRootfs(
	rootfsPath: string,
	options: InitializeRootfsOptions,
): Promise<void> {
	const mountPoint = `/tmp/mount-${Date.now()}`;
	await mkdir(mountPoint, { recursive: true });

	try {
		await $`sudo mount -o loop ${rootfsPath} ${mountPoint}`;

		// 1. SSH key injection
		const sshDir = `${mountPoint}/home/user/.ssh`;
		await $`sudo mkdir -p ${sshDir}`;
		await $`sudo chmod 700 ${sshDir}`;

		const tempKeyFile = `/tmp/authorized_keys_${Date.now()}`;
		await writeFile(tempKeyFile, `${options.sshPublicKey}\n`, { mode: 0o600 });
		await $`sudo cp ${tempKeyFile} ${sshDir}/authorized_keys`;
		await $`sudo chmod 600 ${sshDir}/authorized_keys`;
		await $`rm -f ${tempKeyFile}`;

		// 2. Set ownership of .ssh directory (covers authorized_keys)
		await $`sudo chown -R 1000:1000 ${sshDir}`;

		// 3. Hostname
		if (options.hostname) {
			const tempHostname = `/tmp/hostname_${Date.now()}`;
			await writeFile(tempHostname, `${options.hostname}\n`);
			await $`sudo cp ${tempHostname} ${mountPoint}/etc/hostname`;
			await $`rm -f ${tempHostname}`;

			const tempHosts = `/tmp/hosts_${Date.now()}`;
			await writeFile(
				tempHosts,
				`127.0.0.1\tlocalhost\n::1\t\tlocalhost\n127.0.1.1\t${options.hostname}\n`,
			);
			await $`sudo cp ${tempHosts} ${mountPoint}/etc/hosts`;
			await $`rm -f ${tempHosts}`;
		}
	} finally {
		try {
			await $`sudo umount ${mountPoint}`;
		} catch {
			// Ignore unmount errors
		}
		try {
			await $`rmdir ${mountPoint}`.quiet();
		} catch {
			// Ignore rmdir errors
		}
	}
}
```

**Remove** the `injectSshKey()` function (lines 23–59) and `setHostname()` function (lines 61–94).

#### `src/services/vm.ts`

**Replace** the import of `injectSshKey` and `setHostname` from `./storage` with `initializeRootfs`:

```typescript
import {
	checkAvailableSpace,
	clearAuthorizedKeys,
	copyRootfs,
	copyRootfsToTemplate,
	deleteRootfs,
	initializeRootfs,
	resizeRootfs,
} from "./storage";
```

**Replace** the two separate calls in `createVm()` (lines 222–229):

```typescript
// Before (remove):
console.log(`[${vmId}] Injecting SSH key...`);
await injectSshKey(rootfsPath, req.ssh_public_key);
if (name) {
    console.log(`[${vmId}] Setting hostname to ${name}...`);
    await setHostname(rootfsPath, name);
}

// After (replace with):
console.log(`[${vmId}] Initializing rootfs...`);
await initializeRootfs(rootfsPath, {
    sshPublicKey: req.ssh_public_key,
    hostname: name || undefined,
});
```

### Verification

- Run `./do lint` — passes
- All existing tests pass unchanged (SSH key injection and hostname still work)

---

## Phase 3: Environment Variables

### Goal

Add `env` field support. VMs created with environment variables have them accessible in all SSH sessions (interactive and non-interactive).

### Acceptance Test (Red)

Unskip and implement the test for criterion #1:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `env vars accessible via non-interactive SSH` | #1 | `printenv FOO` returns `bar` and `printenv HELLO` returns `world` |

**Test implementation:**

```typescript
test(
    "env vars accessible via non-interactive SSH",
    async () => {
        const vm = await sbVmCreateWithInit("debian-base", {
            env: ["FOO=bar", "HELLO=world"],
        });
        createdVmIds.push(vm.id as string);

        await waitForSsh(vm.ssh_port as number, 90000);
        const foo = await sshExec(vm.ssh_port as number, "printenv FOO");
        expect(foo.trim()).toBe("bar");
        const hello = await sshExec(vm.ssh_port as number, "printenv HELLO");
        expect(hello.trim()).toBe("world");
    },
    { timeout: 90000 },
);
```

Verify the test **fails** (red) before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/helpers.ts` | Modify | Add `sbVmCreateWithInit()` helper function |
| `test/integration.test.ts` | Modify | Unskip and implement env var test; add `sbVmCreateWithInit` to import from `./helpers` |
| `src/types.ts` | Modify | Add `env` field to `CreateVMRequest` |
| `src/index.ts` | Modify | Add validation for `env` field |
| `src/services/storage.ts` | Modify | Add env var writing and `PermitUserEnvironment` to `initializeRootfs()` |
| `src/services/vm.ts` | Modify | Pass `env` through to `initializeRootfs()` |
| `scripts/sb` | Modify | Add `--env` flag to `cmd_vm_create` and `cmd_go` |

#### `test/helpers.ts`

**Add** a new helper function after `sbVmCreate()`:

```typescript
export async function sbVmCreateWithInit(
	template: string,
	options?: { env?: string[]; files?: string[]; initScript?: string },
): Promise<Record<string, unknown>> {
	const args = ["vm", "create", "-t", template, "-k", `@${TEST_PUBLIC_KEY_PATH}`];
	if (options?.env) {
		for (const e of options.env) {
			args.push("--env", e);
		}
	}
	if (options?.files) {
		for (const f of options.files) {
			args.push("--file", f);
		}
	}
	if (options?.initScript) {
		args.push("--init-script", options.initScript);
	}
	const result = await sbCmd(...args);
	if (result.exitCode !== 0 || !result.data) {
		throw new Error(`Failed to create VM with init options: ${result.error}`);
	}
	return result.data;
}
```

**Note:** The `sbVmCreateWithInit` helper does not need additional imports beyond what `test/helpers.ts` already has.

#### `src/types.ts`

**Add** `env` field to `CreateVMRequest`:

```typescript
export interface CreateVMRequest {
	template: string;
	name?: string;
	ssh_public_key: string;
	vcpu_count?: number;
	mem_size_mib?: number;
	disk_size_gib?: number;
	env?: Record<string, string>;
}
```

#### `src/index.ts`

**Add** validation for the `env` field inside the `app.post("/vms", ...)` handler, after the `disk_size_gib` validation block (after line 143) and before `const vm = await createVm(body)`:

```typescript
if (body.env !== undefined) {
    if (typeof body.env !== "object" || Array.isArray(body.env) || body.env === null) {
        return c.json({ error: "env must be an object of key-value string pairs" }, 400);
    }
    for (const [key, value] of Object.entries(body.env)) {
        if (typeof value !== "string") {
            return c.json({ error: `env value for "${key}" must be a string` }, 400);
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
            return c.json(
                { error: `env key "${key}" is invalid (must match [a-zA-Z_][a-zA-Z0-9_]*)` },
                400,
            );
        }
        if (value.includes("\n")) {
            return c.json(
                { error: `env value for "${key}" must not contain newlines` },
                400,
            );
        }
    }
}
```

#### `src/services/storage.ts`

**Update** the `InitializeRootfsOptions` interface to add `env`:

```typescript
export interface InitializeRootfsOptions {
	sshPublicKey: string;
	hostname?: string;
	env?: Record<string, string>;
}
```

**Add** env var writing inside `initializeRootfs()`, after the SSH key `chown` line and before the hostname block. Insert this code after `await $\`sudo chown -R 1000:1000 ${sshDir}\``:

```typescript
// 3. Environment variables
if (options.env && Object.keys(options.env).length > 0) {
    const envContent = Object.entries(options.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n";
    const tempEnvFile = `/tmp/ssh_environment_${Date.now()}`;
    await writeFile(tempEnvFile, envContent, { mode: 0o640 });
    await $`sudo cp ${tempEnvFile} ${sshDir}/environment`;
    await $`sudo chmod 640 ${sshDir}/environment`;
    await $`sudo chown 1000:1000 ${sshDir}/environment`;
    await $`rm -f ${tempEnvFile}`;

    // Enable PermitUserEnvironment in sshd_config
    const sshdConfig = `${mountPoint}/etc/ssh/sshd_config`;
    await $`sudo sed -i 's/^#\\? *PermitUserEnvironment.*/PermitUserEnvironment yes/' ${sshdConfig}`;
    // Append if sed didn't match anything
    const check = await $`sudo grep -c '^PermitUserEnvironment yes' ${sshdConfig}`.text();
    if (check.trim() === "0") {
        await $`echo 'PermitUserEnvironment yes' | sudo tee -a ${sshdConfig}`.quiet();
    }
}
```

**Renumber** the hostname comment from `// 3.` to `// 4.` (Hostname).

#### `src/services/vm.ts`

**Update** the `initializeRootfs()` call in `createVm()` to pass `env`:

```typescript
await initializeRootfs(rootfsPath, {
    sshPublicKey: req.ssh_public_key,
    hostname: name || undefined,
    env: req.env,
});
```

#### `scripts/sb`

**Update** `cmd_vm_create()`:

1. Add variable declaration after `local disk="" mem=""` (line 342):
   ```bash
   local env_args=()
   ```

2. Add case in the while loop (after the `-k|--key` case):
   ```bash
   --env) env_args+=("$2"); shift 2 ;;
   ```

3. Add env JSON construction after the `mem` block (after line 379) and before `local response`:
   ```bash
   if [[ ${env_args[@]+x} ]]; then
     local env_json="{}"
     for ev in "${env_args[@]}"; do
       local ekey="${ev%%=*}"
       local env_val="${ev#*=}"
       env_json=$(echo "$env_json" | jq --arg k "$ekey" --arg v "$env_val" '. + {($k): $v}')
     done
     json_body=$(echo "$json_body" | jq --argjson e "$env_json" '. + {env: $e}')
   fi
   ```

**Update** `cmd_go()` — this function has identical structure to `cmd_vm_create()`. Insert the same three code blocks at the corresponding locations: (1) variable declaration after `local disk="" mem=""`, (2) case branch after the `-k|--key` case, (3) JSON construction after the `mem` block and before `local response`.

### Verification

- Acceptance test `env vars accessible via non-interactive SSH` passes (green)
- Run `./do lint` — passes
- All existing tests still pass

---

## Phase 4: Files

### Goal

Add `files` field support. VMs created with files have them at the specified paths with correct content, ownership (`user:user`), and permissions (`640`).

### Acceptance Test (Red)

Unskip and implement the test for criterion #2:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `files created with correct content and permissions` | #2 | File exists at `/home/user/test-file.txt` with correct content, owner `user:user`, mode `640` |

**Test implementation:**

```typescript
test(
    "files created with correct content and permissions",
    async () => {
        const testContent = "hello-from-file-test";
        const tmpFile = join(tmpdir(), `scalebox-file-test-${Date.now()}.txt`);
        await writeFileHelper(tmpFile, testContent);

        try {
            const vm = await sbVmCreateWithInit("debian-base", {
                files: [`/home/user/test-file.txt:@${tmpFile}`],
            });
            createdVmIds.push(vm.id as string);

            await waitForSsh(vm.ssh_port as number, 90000);
            const content = await sshExec(vm.ssh_port as number, "cat /home/user/test-file.txt");
            expect(content.trim()).toBe(testContent);

            const perms = await sshExec(
                vm.ssh_port as number,
                "stat -c '%a %U:%G' /home/user/test-file.txt",
            );
            expect(perms.trim()).toBe("640 user:user");
        } finally {
            await rmFile(tmpFile, { force: true });
        }
    },
    { timeout: 90000 },
);
```

**Note:** Add these imports at the top of `test/integration.test.ts` (Phase 3 adds `sbVmCreateWithInit` to the `./helpers` import; Phase 4 adds these):

```typescript
import { writeFile as writeFileHelper, rm as rmFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

`writeFileHelper` is aliased to avoid confusion with any test utilities. `rmFile` is used consistently across all test phases for temp file cleanup.

Verify the test **fails** (red) before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Unskip and implement files test; add imports for `writeFile`, `rm`, `tmpdir`, `join` |
| `src/types.ts` | Modify | Add `files` field to `CreateVMRequest` |
| `src/index.ts` | Modify | Add validation for `files` field |
| `src/services/storage.ts` | Modify | Add file writing to `initializeRootfs()` |
| `src/services/vm.ts` | Modify | Pass `files` through to `initializeRootfs()` |
| `scripts/sb` | Modify | Add `--file` flag to `cmd_vm_create` and `cmd_go` |

#### `src/types.ts`

**Add** `files` field to `CreateVMRequest`:

```typescript
export interface CreateVMRequest {
	template: string;
	name?: string;
	ssh_public_key: string;
	vcpu_count?: number;
	mem_size_mib?: number;
	disk_size_gib?: number;
	env?: Record<string, string>;
	files?: Array<{ path: string; content: string }>;
}
```

#### `src/index.ts`

**Add** validation for the `files` field, after the `env` validation block:

```typescript
if (body.files !== undefined) {
    if (!Array.isArray(body.files)) {
        return c.json({ error: "files must be an array" }, 400);
    }
    for (let i = 0; i < body.files.length; i++) {
        const file = body.files[i];
        if (!file.path || typeof file.path !== "string") {
            return c.json({ error: `files[${i}].path must be a non-empty string` }, 400);
        }
        if (!file.path.startsWith("/")) {
            return c.json({ error: `files[${i}].path must be an absolute path` }, 400);
        }
        if (file.path.includes("..")) {
            return c.json({ error: `files[${i}].path must not contain '..'` }, 400);
        }
        if (!file.content || typeof file.content !== "string") {
            return c.json({ error: `files[${i}].content must be a non-empty string` }, 400);
        }
    }
}
```

#### `src/services/storage.ts`

**Update** `InitializeRootfsOptions`:

```typescript
export interface InitializeRootfsOptions {
	sshPublicKey: string;
	hostname?: string;
	env?: Record<string, string>;
	files?: Array<{ path: string; content: string }>;
}
```

**Add** `Buffer` import at the top of the file (Bun global, no import needed — `Buffer` is available globally in Bun).

**Add** file writing inside `initializeRootfs()`, after the hostname block and before the `finally`:

```typescript
// 5. Files
if (options.files && options.files.length > 0) {
    for (const file of options.files) {
        const decoded = Buffer.from(file.content, "base64");
        const targetPath = `${mountPoint}${file.path}`;
        const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));

        await $`sudo mkdir -p ${parentDir}`;

        const tempFile = `/tmp/scalebox_file_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await writeFile(tempFile, decoded, { mode: 0o640 });
        await $`sudo cp ${tempFile} ${targetPath}`;
        await $`sudo chmod 640 ${targetPath}`;
        await $`sudo chown 1000:1000 ${targetPath}`;
        await $`rm -f ${tempFile}`;

        // Ensure parent directories are also owned by user
        // (only for dirs under /home/user)
        if (file.path.startsWith("/home/user/")) {
            await $`sudo chown 1000:1000 ${parentDir}`;
        }
    }
}
```

#### `src/services/vm.ts`

**Update** the `initializeRootfs()` call to pass `files`:

```typescript
await initializeRootfs(rootfsPath, {
    sshPublicKey: req.ssh_public_key,
    hostname: name || undefined,
    env: req.env,
    files: req.files,
});
```

#### `scripts/sb`

**Update** `cmd_vm_create()`:

1. Add variable declaration alongside `env_args`:
   ```bash
   local file_args=()
   ```

2. Add case in the while loop:
   ```bash
   --file) file_args+=("$2"); shift 2 ;;
   ```

3. Add file JSON construction after the env block:
   ```bash
   if [[ ${file_args[@]+x} ]]; then
     local files_json="[]"
     for fspec in "${file_args[@]}"; do
       local fpath="${fspec%%:@*}"
       local flocal="${fspec#*:@}"
       [[ -f "$flocal" ]] || die "File not found: $flocal"
       local fb64
       fb64=$(base64 < "$flocal" | tr -d '\n')
       files_json=$(echo "$files_json" | jq --arg p "$fpath" --arg c "$fb64" '. + [{path: $p, content: $c}]')
     done
     json_body=$(echo "$json_body" | jq --argjson f "$files_json" '. + {files: $f}')
   fi
   ```

**Update** `cmd_go()` with the same three changes.

### Verification

- Acceptance test `files created with correct content and permissions` passes (green)
- Run `./do lint` — passes
- All existing tests and phase 3 test still pass

---

## Phase 5: Init Script

### Goal

Add `init_script` field support. VMs created with an init script have it executed as root on first boot via a systemd one-shot service. The service self-disables and removes the script after execution.

### Acceptance Tests (Red)

Unskip and implement tests for criteria #3, #4, #5:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `init script executed on boot` | #3 | Marker file `/home/user/init-result.txt` contains `init-completed` |
| `init script has access to env vars` | #4 | File `/home/user/env-from-init.txt` contains env var value |
| `init script removed after execution` | #5 | `/opt/scalebox/init.sh` does not exist; `scalebox-init.service` is disabled |

**Test implementations:**

```typescript
test(
    "init script executed on boot",
    async () => {
        const tmpScript = join(tmpdir(), `scalebox-init-test-${Date.now()}.sh`);
        await writeFileHelper(
            tmpScript,
            '#!/bin/bash\necho "init-completed" > /home/user/init-result.txt\nchown 1000:1000 /home/user/init-result.txt\n',
        );

        try {
            const vm = await sbVmCreateWithInit("debian-base", {
                initScript: tmpScript,
            });
            createdVmIds.push(vm.id as string);

            await waitForSsh(vm.ssh_port as number, 90000);
            // Poll for init script completion (runs as boot service, may not be done yet)
            let result = "";
            for (let i = 0; i < 30; i++) {
                try {
                    result = await sshExec(
                        vm.ssh_port as number,
                        "cat /home/user/init-result.txt 2>/dev/null || echo PENDING",
                    );
                    if (result.trim() !== "PENDING") break;
                } catch {}
                await Bun.sleep(1000);
            }
            expect(result.trim()).toBe("init-completed");
        } finally {
            await rmFile(tmpScript, { force: true });
        }
    },
    { timeout: 150000 },
);

test(
    "init script has access to env vars",
    async () => {
        const tmpScript = join(tmpdir(), `scalebox-init-env-${Date.now()}.sh`);
        await writeFileHelper(
            tmpScript,
            '#!/bin/bash\necho "$MY_TEST_VAR" > /home/user/env-from-init.txt\nchown 1000:1000 /home/user/env-from-init.txt\n',
        );

        try {
            const vm = await sbVmCreateWithInit("debian-base", {
                env: ["MY_TEST_VAR=hello-from-env"],
                initScript: tmpScript,
            });
            createdVmIds.push(vm.id as string);

            await waitForSsh(vm.ssh_port as number, 90000);
            let result = "";
            for (let i = 0; i < 30; i++) {
                try {
                    result = await sshExec(
                        vm.ssh_port as number,
                        "cat /home/user/env-from-init.txt 2>/dev/null || echo PENDING",
                    );
                    if (result.trim() !== "PENDING") break;
                } catch {}
                await Bun.sleep(1000);
            }
            expect(result.trim()).toBe("hello-from-env");
        } finally {
            await rmFile(tmpScript, { force: true });
        }
    },
    { timeout: 150000 },
);

test(
    "init script removed after execution",
    async () => {
        const tmpScript = join(tmpdir(), `scalebox-init-cleanup-${Date.now()}.sh`);
        await writeFileHelper(
            tmpScript,
            '#!/bin/bash\necho done > /home/user/init-done.txt\nchown 1000:1000 /home/user/init-done.txt\n',
        );

        try {
            const vm = await sbVmCreateWithInit("debian-base", {
                initScript: tmpScript,
            });
            createdVmIds.push(vm.id as string);

            await waitForSsh(vm.ssh_port as number, 90000);
            // Wait for init to complete
            for (let i = 0; i < 30; i++) {
                try {
                    const done = await sshExec(
                        vm.ssh_port as number,
                        "cat /home/user/init-done.txt 2>/dev/null || echo PENDING",
                    );
                    if (done.trim() !== "PENDING") break;
                } catch {}
                await Bun.sleep(1000);
            }

            // Verify script is removed
            const scriptExists = await sshExec(
                vm.ssh_port as number,
                "test -f /opt/scalebox/init.sh && echo exists || echo gone",
            );
            expect(scriptExists.trim()).toBe("gone");

            // Verify service is disabled
            const serviceEnabled = await sshExec(
                vm.ssh_port as number,
                "systemctl is-enabled scalebox-init.service 2>/dev/null || echo disabled",
            );
            expect(serviceEnabled.trim()).toBe("disabled");
        } finally {
            await rmFile(tmpScript, { force: true });
        }
    },
    { timeout: 150000 },
);
```

Verify the tests **fail** (red) before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Unskip and implement 3 init script tests |
| `src/types.ts` | Modify | Add `init_script` field to `CreateVMRequest` |
| `src/index.ts` | Modify | Add validation for `init_script` field |
| `src/services/storage.ts` | Modify | Add init script + systemd unit writing to `initializeRootfs()` |
| `src/services/vm.ts` | Modify | Pass `init_script` through to `initializeRootfs()` |
| `scripts/sb` | Modify | Add `--init-script` flag to `cmd_vm_create` and `cmd_go` |

#### `src/types.ts`

**Add** `init_script` field to `CreateVMRequest`:

```typescript
export interface CreateVMRequest {
	template: string;
	name?: string;
	ssh_public_key: string;
	vcpu_count?: number;
	mem_size_mib?: number;
	disk_size_gib?: number;
	env?: Record<string, string>;
	files?: Array<{ path: string; content: string }>;
	init_script?: string;
}
```

#### `src/index.ts`

**Add** validation after the `files` validation block:

```typescript
if (body.init_script !== undefined) {
    if (typeof body.init_script !== "string" || body.init_script.length === 0) {
        return c.json({ error: "init_script must be a non-empty base64-encoded string" }, 400);
    }
}
```

#### `src/services/storage.ts`

**Update** `InitializeRootfsOptions`:

```typescript
export interface InitializeRootfsOptions {
	sshPublicKey: string;
	hostname?: string;
	env?: Record<string, string>;
	files?: Array<{ path: string; content: string }>;
	initScript?: string;
}
```

**Add** init script writing inside `initializeRootfs()`, after the files block:

```typescript
// 6. Init script
if (options.initScript) {
    const scriptContent = Buffer.from(options.initScript, "base64").toString();

    // Write the init script
    await $`sudo mkdir -p ${mountPoint}/opt/scalebox`;
    const tempScript = `/tmp/scalebox_init_${Date.now()}`;
    await writeFile(tempScript, scriptContent, { mode: 0o755 });
    await $`sudo cp ${tempScript} ${mountPoint}/opt/scalebox/init.sh`;
    await $`sudo chmod 755 ${mountPoint}/opt/scalebox/init.sh`;
    await $`rm -f ${tempScript}`;

    // Write the systemd service unit
    const serviceContent = `[Unit]
Description=Scalebox Init Script
After=network-online.target
Wants=network-online.target
ConditionPathExists=/opt/scalebox/init.sh

[Service]
Type=oneshot
ExecStart=/bin/bash -c '/opt/scalebox/init.sh; _rc=$$?; rm -f /opt/scalebox/init.sh; systemctl disable scalebox-init.service; exit $$_rc'
EnvironmentFile=-/home/user/.ssh/environment
StandardOutput=journal
StandardError=journal
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;
    const tempService = `/tmp/scalebox_init_service_${Date.now()}`;
    await writeFile(tempService, serviceContent);
    await $`sudo cp ${tempService} ${mountPoint}/etc/systemd/system/scalebox-init.service`;
    await $`rm -f ${tempService}`;

    // Enable the service via symlink (cannot use systemctl on mounted fs)
    await $`sudo mkdir -p ${mountPoint}/etc/systemd/system/multi-user.target.wants`;
    await $`sudo ln -sf /etc/systemd/system/scalebox-init.service ${mountPoint}/etc/systemd/system/multi-user.target.wants/scalebox-init.service`;
}
```

**Note on `$$` escaping:** In the systemd unit file, `$$` is the systemd syntax for a literal `$`. This ensures `$?` and `$_rc` are evaluated by bash at runtime, not by systemd.

#### `src/services/vm.ts`

**Update** the `initializeRootfs()` call to pass `initScript`:

```typescript
await initializeRootfs(rootfsPath, {
    sshPublicKey: req.ssh_public_key,
    hostname: name || undefined,
    env: req.env,
    files: req.files,
    initScript: req.init_script,
});
```

#### `scripts/sb`

**Update** `cmd_vm_create()`:

1. Add variable declaration:
   ```bash
   local init_script_b64=""
   ```

2. Add case in the while loop:
   ```bash
   --init-script)
     local script_file="$2"
     [[ -f "$script_file" ]] || die "Init script not found: $script_file"
     init_script_b64=$(base64 < "$script_file" | tr -d '\n')
     shift 2
     ;;
   ```

3. Add init script JSON construction after the files block:
   ```bash
   if [[ -n "$init_script_b64" ]]; then
     json_body=$(echo "$json_body" | jq --arg s "$init_script_b64" '. + {init_script: $s}')
   fi
   ```

**Update** `cmd_go()` with the same three changes.

### Verification

- All 3 init script acceptance tests pass (green)
- Run `./do lint` — passes
- All previous tests still pass

---

## Phase 6: Combined Test

### Goal

Verify all three features work together in a single VM creation.

### Acceptance Test (Red)

Unskip and implement test for criterion #6:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `env, files, and init script work together` | #6 | Env vars accessible, file exists with correct content/perms, init script ran successfully using env vars |

**Test implementation:**

```typescript
test(
    "env, files, and init script work together",
    async () => {
        const tmpFile = join(tmpdir(), `scalebox-combined-file-${Date.now()}.txt`);
        await writeFileHelper(tmpFile, "combined-file-content");

        const tmpScript = join(tmpdir(), `scalebox-combined-init-${Date.now()}.sh`);
        await writeFileHelper(
            tmpScript,
            '#!/bin/bash\necho "$COMBINED_VAR" > /home/user/combined-init.txt\nchown 1000:1000 /home/user/combined-init.txt\n',
        );

        try {
            const vm = await sbVmCreateWithInit("debian-base", {
                env: ["COMBINED_VAR=it-works"],
                files: [`/home/user/combined-file.txt:@${tmpFile}`],
                initScript: tmpScript,
            });
            createdVmIds.push(vm.id as string);

            await waitForSsh(vm.ssh_port as number, 90000);

            // Verify env var
            const envVal = await sshExec(vm.ssh_port as number, "printenv COMBINED_VAR");
            expect(envVal.trim()).toBe("it-works");

            // Verify file
            const fileContent = await sshExec(
                vm.ssh_port as number,
                "cat /home/user/combined-file.txt",
            );
            expect(fileContent.trim()).toBe("combined-file-content");

            const filePerms = await sshExec(
                vm.ssh_port as number,
                "stat -c '%a %U:%G' /home/user/combined-file.txt",
            );
            expect(filePerms.trim()).toBe("640 user:user");

            // Verify init script ran with env vars
            let initResult = "";
            for (let i = 0; i < 30; i++) {
                try {
                    initResult = await sshExec(
                        vm.ssh_port as number,
                        "cat /home/user/combined-init.txt 2>/dev/null || echo PENDING",
                    );
                    if (initResult.trim() !== "PENDING") break;
                } catch {}
                await Bun.sleep(1000);
            }
            expect(initResult.trim()).toBe("it-works");
        } finally {
            await rmFile(tmpFile, { force: true });
            await rmFile(tmpScript, { force: true });
        }
    },
    { timeout: 150000 },
);
```

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Unskip and implement combined test |

### Verification

- Acceptance test `env, files, and init script work together` passes (green)
- Run `./do check` — full pipeline passes

---

## Phase 7: CLI Help Text

### Goal

Update the CLI help text to document the new flags.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/sb` | Modify | Update `cmd_help()` to include `--env`, `--file`, `--init-script` |

**Update** the `vm create` and `go` help lines in `cmd_help()`:

```
  vm create [-t TPL] [-k KEY] [-d DISK] [-m MEM] [--env K=V]... [--file PATH:@FILE]... [--init-script FILE]
                                Create VM (template defaults to debian-base)
```

```
  go [-t TPL] [-k KEY] [-d DISK] [-m MEM] [--env K=V]... [--file PATH:@FILE]... [--init-script FILE]
                                Create VM and connect immediately
                                (template defaults to debian-base)
```

**Add** to the Examples section:

```
  sb vm create --env DB_HOST=db.example.com --env DB_PORT=5432
  sb vm create --file /home/user/.env:@.env --file /home/user/config.json:@config.json
  sb vm create --init-script setup.sh --env API_KEY=secret
```

### Verification

- `sb help` shows new flags
- Run `./do lint` — passes

---

## Phase 8: DDD — Update Glossary

### Goal

Document the new domain concepts introduced by this feature.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/DDD/glossary.md` | Modify | Add definitions for new terms; update "VM Creation" process definition |
| `product/DDD/contexts/storage.md` | Modify | Replace `injectSshKey()`/`setHostname()` docs with `initializeRootfs()` |
| `product/DDD/contexts/vm-lifecycle.md` | Modify | Update Storage integration points to reference `initializeRootfs()` |
| `product/DDD/context-map.md` | Modify | Update VM Lifecycle → Storage relationship description |

**Update** the existing **VM Creation** process definition in `product/DDD/glossary.md` to: "allocate resources → copy rootfs → initialize rootfs (SSH key, hostname, env vars, files, init script) → create TAP → start Firecracker → start proxy."

**Add** to `product/DDD/glossary.md` under a new **VM Initialization** subsection within the Storage section:

- **Environment Variables (VM)**: Key-value pairs injected into a VM's `~/.ssh/environment` file during creation. Accessible in all SSH sessions (interactive and non-interactive) via OpenSSH's `PermitUserEnvironment` feature. Also available to the init script via systemd `EnvironmentFile`.
- **VM Files**: Base64-encoded file contents injected into the VM rootfs at specified absolute paths during creation. Owned by `user:user` (UID 1000), mode `640`. Parent directories are created automatically.
- **Init Script**: A bash script injected into the VM rootfs at `/opt/scalebox/init.sh` during creation and executed as root on first boot via a one-shot systemd service (`scalebox-init.service`). Self-disables and removes the script after execution. Analogous to cloud-init user data.
- **Rootfs Initialization**: The consolidated mount operation (`initializeRootfs`) that prepares a VM's rootfs before boot: SSH key injection, hostname setting, environment variable writing, file creation, and init script installation. Performs all operations in a single mount/unmount cycle for efficiency.

**Update** `product/DDD/contexts/storage.md`:
- Remove the `injectSshKey()` and `setHostname()` domain service entries
- Add `initializeRootfs(rootfsPath, options)` as the consolidated domain service, describing its `InitializeRootfsOptions` interface and the single-mount-cycle design
- Update the mount operations sequence diagram to show the consolidated flow

**Update** `product/DDD/contexts/vm-lifecycle.md`:
- Update the Storage integration code example to show `initializeRootfs()` instead of `injectSshKey()` + `setHostname()`

**Update** `product/DDD/context-map.md`:
- Update the VM Lifecycle → Storage relationship from "copies rootfs and injects SSH keys" to "copies rootfs and initializes VM environment (SSH keys, hostname, env vars, files, init script)"

### Verification

- Review documentation for accuracy and completeness

---

## Phase 9: ADR — VM Initialization

### Goal

Record the architectural decision for the VM initialization approach.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/ADR/018-vm-initialization.md` | Create | ADR documenting the VM initialization design |

**Content:**

The ADR should document:

- **Context**: Need for cloud-init-like VM customization at creation time.
- **Decision**: Inject env vars, files, and init scripts into the rootfs during the mount phase (before boot), using `~/.ssh/environment` for per-user env vars, `PermitUserEnvironment` set automatically in sshd_config, and a self-disabling systemd one-shot service for init scripts.
- **Rationale**: Pre-boot injection is faster than post-boot SSH (no wait for SSH readiness), more reliable (doesn't depend on SSH working), and follows the established rootfs mount pattern. `~/.ssh/environment` provides per-user scope without system-wide exposure. Consolidated mount reduces I/O overhead.
- **Alternatives considered**: Post-boot SSH execution (rejected: adds latency, couples to SSH); `/etc/environment` (rejected: system-wide, exposes to all users); `~/.bashrc` (rejected: bash-only, not available in non-interactive sessions); cloud-init (rejected: heavy dependency for simple use case).
- **Consequences**: Base image agnostic — `PermitUserEnvironment` is set during mount, not baked into the image. Init script runs asynchronously during boot — callers cannot know when it completes via the API. Snapshots are clean — init script and service are removed after execution.

### Verification

- Review ADR for completeness

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/types.ts` | Modify | Add `env`, `files`, `init_script` to `CreateVMRequest` |
| `src/services/storage.ts` | Modify | Replace `injectSshKey`/`setHostname` with consolidated `initializeRootfs()` supporting env, files, init script |
| `src/services/vm.ts` | Modify | Pass new fields through to `initializeRootfs()` |
| `src/index.ts` | Modify | Add input validation for new fields |
| `scripts/sb` | Modify | Add `--env`, `--file`, `--init-script` flags to `cmd_vm_create` and `cmd_go`; update help text |
| `test/helpers.ts` | Modify | Add `sbVmCreateWithInit()` helper |
| `test/integration.test.ts` | Modify | Add 6 acceptance tests for VM initialization |
| `product/DDD/glossary.md` | Modify | Add VM initialization terms; update VM Creation process |
| `product/DDD/contexts/storage.md` | Modify | Replace old function docs with `initializeRootfs()` |
| `product/DDD/contexts/vm-lifecycle.md` | Modify | Update Storage integration points |
| `product/DDD/context-map.md` | Modify | Update VM Lifecycle → Storage relationship |
| `product/ADR/018-vm-initialization.md` | Create | ADR for VM initialization design |

---

## End-to-End Verification

After all phases are complete:

1. All 6 new acceptance tests pass (none skipped)
2. All existing tests pass unchanged
3. `./do check` passes — full pipeline
4. Manual verification:
   - `sb vm create -t debian-base --env FOO=bar --file /home/user/test.txt:@test.txt --init-script setup.sh`
   - SSH into VM, verify `printenv FOO` returns `bar`
   - Verify `/home/user/test.txt` exists with correct content
   - `journalctl -u scalebox-init` shows script execution
   - `/opt/scalebox/init.sh` is gone
   - `systemctl is-enabled scalebox-init.service` returns `disabled`

---

## Update Considerations

- **Config changes**: None — no new config keys needed
- **Storage changes**: None — no new directories (VM rootfs paths unchanged)
- **Dependency changes**: None — no new packages
- **Migration needed**: No
- **Backwards compatibility**: Fully backwards compatible:
  - All new fields are optional with no defaults
  - VMs created without new fields behave identically to before
  - `PermitUserEnvironment` is only set when env vars are provided
  - Works with old templates (pre-existing base images) because `PermitUserEnvironment` is set at mount time
