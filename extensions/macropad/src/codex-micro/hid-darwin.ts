/**
 * Minimal macOS IOKit HID bindings via koffi FFI.
 *
 * WHY koffi AND NOT node-hid:
 * OpenClaw installs plugin dependencies with `--ignore-scripts` unconditionally.
 * `node-hid` gets its binary from a `prebuild-install` *install script*, so it
 * arrives broken. `koffi` ships as per-platform prebuilt `optionalDependencies`,
 * which survive `--ignore-scripts`. Everything below therefore adds ZERO native
 * build steps.
 *
 * Scope: exactly the IOKit surface needed to talk to the Codex Micro vendor
 * channel. Each binding is commented with its real C signature.
 *
 * MACOS ONLY BY CONSTRUCTION. Loading IOKit off macOS throws, so every symbol
 * lives behind `bindings()`, resolved on first use rather than at import time.
 * That keeps this module importable everywhere - including in the device-free
 * unit tests and on a Linux Gateway - and lets `createCodexMicroTransport`
 * decide inertness with a plain `process.platform` check instead of a try/catch
 * around an import.
 *
 * THREADING: IOKit delivers input reports through a CFRunLoop. Node's main
 * thread runs libuv, not a CFRunLoop, so we schedule the device on the main
 * thread's run loop and pump it in short slices from a timer (`pump()`).
 * koffi's registered callbacks are invoked synchronously on the calling thread,
 * so the input callback lands on the JS main thread inside `pump()`.
 */
import koffi from "koffi";

export const kIOReturnSuccess = 0;

/** IOHIDReportType */
const kIOHIDReportTypeOutput = 1;

/** Open non-exclusively; a seize open returns kIOReturnNoDevice on this device. */
const kIOHIDOptionsTypeNone = 0;

const kCFStringEncodingUTF8 = 0x08_00_01_00;
const kCFNumberSInt32Type = 3;

type Bindings = ReturnType<typeof loadBindings>;

function loadBindings() {
  const api = koffi;
  const iokit = api.load("/System/Library/Frameworks/IOKit.framework/IOKit");
  const cf = api.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  let IOHIDCheckAccess: ((requestType: number) => number) | undefined;
  try {
    // IOHIDCheckAccess is a read-only TCC query. Never call IOHIDRequestAccess
    // here; plugin startup must not display or imply an OS permission prompt.
    IOHIDCheckAccess = iokit.func("IOHIDCheckAccess", "int32", ["int"]);
  } catch {
    // Older macOS releases do not export this query; report permission unknown.
  }

  // typedef void (*IOHIDReportCallback)(void *context, IOReturn result, void *sender,
  //                                     IOHIDReportType type, uint32_t reportID,
  //                                     uint8_t *report, CFIndex reportLength);
  const IOHIDReportCallbackProto = api.proto(
    "void IOHIDReportCallback(void *context, int32_t result, void *sender, int type, uint32_t reportID, void *report, long reportLength)",
  );

  return {
    api,
    IOHIDReportCallbackProto,
    IOHIDCheckAccess,

    // CFStringRef CFStringCreateWithCString(CFAllocatorRef, const char *, CFStringEncoding);
    CFStringCreateWithCString: cf.func("CFStringCreateWithCString", "void *", [
      "void *",
      "str",
      "uint32",
    ]),
    // Boolean CFStringGetCString(CFStringRef, char *buffer, CFIndex bufferSize, CFStringEncoding);
    CFStringGetCString: cf.func("CFStringGetCString", "bool", [
      "void *",
      api.out(api.pointer("char")),
      "long",
      "uint32",
    ]),
    // Boolean CFNumberGetValue(CFNumberRef, CFNumberType, void *valuePtr);
    CFNumberGetValue: cf.func("CFNumberGetValue", "bool", ["void *", "int", "void *"]),
    // CFIndex CFSetGetCount(CFSetRef);
    CFSetGetCount: cf.func("CFSetGetCount", "long", ["void *"]),
    // void CFSetGetValues(CFSetRef, const void **values);
    CFSetGetValues: cf.func("CFSetGetValues", "void", ["void *", "void *"]),
    // void CFRelease(CFTypeRef);
    CFRelease: cf.func("CFRelease", "void", ["void *"]),
    // CFRunLoopRef CFRunLoopGetCurrent(void);
    CFRunLoopGetCurrent: cf.func("CFRunLoopGetCurrent", "void *", []),
    // SInt32 CFRunLoopRunInMode(CFStringRef mode, CFTimeInterval seconds, Boolean returnAfterSourceHandled);
    CFRunLoopRunInMode: cf.func("CFRunLoopRunInMode", "int32", ["void *", "double", "bool"]),

    // IOHIDManagerRef IOHIDManagerCreate(CFAllocatorRef, IOOptionBits);
    IOHIDManagerCreate: iokit.func("IOHIDManagerCreate", "void *", ["void *", "uint32"]),
    // void IOHIDManagerSetDeviceMatching(IOHIDManagerRef, CFDictionaryRef);
    IOHIDManagerSetDeviceMatching: iokit.func("IOHIDManagerSetDeviceMatching", "void", [
      "void *",
      "void *",
    ]),
    // IOReturn IOHIDManagerOpen(IOHIDManagerRef, IOOptionBits);
    IOHIDManagerOpen: iokit.func("IOHIDManagerOpen", "int32", ["void *", "uint32"]),
    // IOReturn IOHIDManagerClose(IOHIDManagerRef, IOOptionBits);
    IOHIDManagerClose: iokit.func("IOHIDManagerClose", "int32", ["void *", "uint32"]),
    // CFSetRef IOHIDManagerCopyDevices(IOHIDManagerRef);
    IOHIDManagerCopyDevices: iokit.func("IOHIDManagerCopyDevices", "void *", ["void *"]),
    // CFTypeRef IOHIDDeviceGetProperty(IOHIDDeviceRef, CFStringRef key);
    IOHIDDeviceGetProperty: iokit.func("IOHIDDeviceGetProperty", "void *", ["void *", "void *"]),
    // IOReturn IOHIDDeviceOpen(IOHIDDeviceRef, IOOptionBits);
    IOHIDDeviceOpen: iokit.func("IOHIDDeviceOpen", "int32", ["void *", "uint32"]),
    // IOReturn IOHIDDeviceClose(IOHIDDeviceRef, IOOptionBits);
    IOHIDDeviceClose: iokit.func("IOHIDDeviceClose", "int32", ["void *", "uint32"]),
    // IOReturn IOHIDDeviceSetReport(IOHIDDeviceRef, IOHIDReportType, CFIndex reportID,
    //                               const uint8_t *report, CFIndex reportLength);
    IOHIDDeviceSetReport: iokit.func("IOHIDDeviceSetReport", "int32", [
      "void *",
      "int",
      "long",
      "void *",
      "long",
    ]),
    // void IOHIDDeviceScheduleWithRunLoop(IOHIDDeviceRef, CFRunLoopRef, CFStringRef mode);
    IOHIDDeviceScheduleWithRunLoop: iokit.func("IOHIDDeviceScheduleWithRunLoop", "void", [
      "void *",
      "void *",
      "void *",
    ]),
    // void IOHIDDeviceUnscheduleFromRunLoop(IOHIDDeviceRef, CFRunLoopRef, CFStringRef mode);
    IOHIDDeviceUnscheduleFromRunLoop: iokit.func("IOHIDDeviceUnscheduleFromRunLoop", "void", [
      "void *",
      "void *",
      "void *",
    ]),
    // void IOHIDDeviceRegisterInputReportCallback(IOHIDDeviceRef, uint8_t *report, CFIndex reportLength,
    //                                             IOHIDReportCallback callback, void *context);
    IOHIDDeviceRegisterInputReportCallback: iokit.func(
      "IOHIDDeviceRegisterInputReportCallback",
      "void",
      ["void *", "void *", "long", api.pointer(IOHIDReportCallbackProto), "void *"],
    ),
  };
}

let cachedBindings: Bindings | undefined;

/**
 * Resolve the IOKit/CoreFoundation symbols, once.
 *
 * Throws off macOS, or if koffi cannot load the frameworks. Callers that need
 * inertness rather than an error must gate on `isDarwinHidAvailable()` first.
 */
function bindings(): Bindings {
  if (!cachedBindings) {
    if (process.platform !== "darwin") {
      throw new Error(
        `macropad: the IOKit HID backend is macOS-only (platform=${process.platform})`,
      );
    }
    cachedBindings = loadBindings();
  }
  return cachedBindings;
}

/**
 * True when this process can actually reach IOKit through koffi.
 *
 * Deliberately swallows the failure: a Gateway on Linux, or one whose koffi
 * prebuild is missing for its architecture, must stay inert rather than log a
 * native-loader stack trace on every service start.
 */
export function isDarwinHidAvailable(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    bindings();
    return true;
  } catch {
    return false;
  }
}

export type InputPermission = "granted" | "denied" | "unknown" | "unsupported";

/** Inspect Input Monitoring without prompting for permission. */
export function inspectInputMonitoringPermission(): InputPermission {
  if (process.platform !== "darwin") {
    return "unsupported";
  }
  try {
    const result = bindings().IOHIDCheckAccess?.(1); // kIOHIDRequestTypeListenEvent
    if (result === 0) {
      return "granted";
    }
    if (result === 1) {
      return "denied";
    }
  } catch {
    // The query is optional on older macOS and can fail independently of HID.
  }
  return "unknown";
}

const cfStringCache = new Map<string, unknown>();

/** Interned CFStringRef. These are process-lifetime constants; never released. */
function cfstr(value: string): unknown {
  let ref = cfStringCache.get(value);
  if (ref === undefined) {
    ref = bindings().CFStringCreateWithCString(null, value, kCFStringEncodingUTF8);
    cfStringCache.set(value, ref);
  }
  return ref;
}

/**
 * Run-loop mode name. CFRunLoop matches modes by string value, so a string we
 * create ourselves is equivalent to the `kCFRunLoopDefaultMode` global (which,
 * being a data symbol rather than a function, is awkward to reach through FFI).
 */
function defaultRunLoopMode(): unknown {
  return cfstr("kCFRunLoopDefaultMode");
}

function numberProperty(device: unknown, key: string): number | null {
  const ref = bindings().IOHIDDeviceGetProperty(device, cfstr(key));
  if (!ref) {
    return null;
  }
  const out = Buffer.alloc(4);
  if (!bindings().CFNumberGetValue(ref, kCFNumberSInt32Type, out)) {
    return null;
  }
  return out.readInt32LE(0);
}

function stringProperty(device: unknown, key: string): string | null {
  const ref = bindings().IOHIDDeviceGetProperty(device, cfstr(key));
  if (!ref) {
    return null;
  }
  const buf = Buffer.alloc(512);
  if (!bindings().CFStringGetCString(ref, buf, buf.length, kCFStringEncodingUTF8)) {
    return null;
  }
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString("utf8");
}

/** Decode an IOReturn into the hex form Apple documents it as. */
export function ioReturnHex(code: number): string {
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

export type HidDeviceInfo = {
  handle: unknown;
  vendorId: number;
  productId: number;
  product: string | null;
  transport: string | null;
  serialNumber: string | null;
  primaryUsagePage: number | null;
  primaryUsage: number | null;
  maxInputReportSize: number | null;
  maxOutputReportSize: number | null;
};

let sharedManager: unknown = null;

function manager(): unknown {
  if (sharedManager === null) {
    const bound = bindings();
    sharedManager = bound.IOHIDManagerCreate(null, kIOHIDOptionsTypeNone);
    if (!sharedManager) {
      throw new Error("IOHIDManagerCreate returned NULL");
    }
    // NULL matching dictionary == match everything; we filter in JS. This avoids
    // hand-building a CFDictionary over FFI for no benefit.
    bound.IOHIDManagerSetDeviceMatching(sharedManager, null);
    const result = bound.IOHIDManagerOpen(sharedManager, kIOHIDOptionsTypeNone);
    if (result !== kIOReturnSuccess) {
      sharedManager = null;
      throw new Error(`IOHIDManagerOpen failed: ${ioReturnHex(result)}`);
    }
  }
  return sharedManager;
}

/** Every HID device the manager can see, with the properties we care about. */
function enumerateDevices(): HidDeviceInfo[] {
  const bound = bindings();
  const set = bound.IOHIDManagerCopyDevices(manager());
  if (!set) {
    return [];
  }

  let values: unknown = null;
  try {
    const count = Number(bound.CFSetGetCount(set));
    if (count <= 0) {
      return [];
    }

    // CFSetGetValues fills an array of `count` pointers.
    values = bound.api.alloc("void *", count);
    bound.CFSetGetValues(set, values);

    const out: HidDeviceInfo[] = [];
    for (let i = 0; i < count; i++) {
      const handle = bound.api.decode(values, i * bound.api.sizeof("void *"), "void *");
      if (!handle) {
        continue;
      }
      out.push({
        handle,
        vendorId: numberProperty(handle, "VendorID") ?? -1,
        productId: numberProperty(handle, "ProductID") ?? -1,
        product: stringProperty(handle, "Product"),
        transport: stringProperty(handle, "Transport"),
        serialNumber: stringProperty(handle, "SerialNumber"),
        primaryUsagePage: numberProperty(handle, "PrimaryUsagePage"),
        primaryUsage: numberProperty(handle, "PrimaryUsage"),
        maxInputReportSize: numberProperty(handle, "MaxInputReportSize"),
        maxOutputReportSize: numberProperty(handle, "MaxOutputReportSize"),
      });
    }
    return out;
  } finally {
    if (values !== null) {
      bound.api.free(values);
    }
    bound.CFRelease(set);
  }
}

export type FindOptions = {
  vendorId: number;
  productId: number;
  serialNumber?: string;
  /** Preferred top-level collection usage page/usage, when the firmware exposes one. */
  usagePage?: number;
  usage?: number;
};

/**
 * Find the collection that carries the vendor channel.
 *
 * VERIFIED LIVE, AND COUNTER-INTUITIVE: this device presents exactly ONE
 * `IOHIDDevice`, whose `PrimaryUsagePage`/`PrimaryUsage` is `0x01`/`0x06` - the
 * *keyboard* collection. There is no separate `0xFF00` device object to open,
 * so code that filters for one finds nothing at all. The vendor channel is
 * addressed purely by report ID 6 on that single device.
 *
 * The usage-page preference is still expressed in case a future firmware splits
 * the collections, but the fallback - the collection able to carry a 64-byte
 * output report - is what actually matches today.
 */
export function findDevice(opts: FindOptions): HidDeviceInfo | null {
  const candidates = enumerateDevices().filter(
    (device) =>
      device.vendorId === opts.vendorId &&
      device.productId === opts.productId &&
      (opts.serialNumber === undefined || device.serialNumber === opts.serialNumber),
  );
  if (candidates.length === 0) {
    return null;
  }

  if (opts.usagePage !== undefined) {
    const exact = candidates.find(
      (device) =>
        device.primaryUsagePage === opts.usagePage &&
        (opts.usage === undefined || device.primaryUsage === opts.usage),
    );
    if (exact) {
      return exact;
    }
  }

  return candidates.find((device) => device.maxOutputReportSize === 64) ?? candidates[0]!;
}

export type InputReportHandler = (reportId: number, data: Uint8Array) => void;

class HidError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(`${message}: ${ioReturnHex(code)}`);
    this.name = "HidError";
    this.code = code;
  }
}

export class HidDevice {
  readonly info: HidDeviceInfo;
  #open = false;
  #scheduled = false;

  // These three MUST stay referenced for the lifetime of the registration:
  // IOKit writes into #inputBuffer from the kernel and calls #callbackPtr.
  // If GC collected either, we would crash or silently stop receiving.
  #inputBuffer: unknown = null;
  #callbackPtr: bigint | null = null;
  #handler: InputReportHandler | null = null;

  /** Reports actually delivered to our callback; not an inferred kernel traffic counter. */
  inputReportCount = 0;
  /** Successful `IOHIDDeviceSetReport` calls. NOT proof of delivery - see `setOutputReport`. */
  setReportCount = 0;

  constructor(info: HidDeviceInfo) {
    this.info = info;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /**
   * Open NON-EXCLUSIVELY. A seize open returns `kIOReturnNoDevice` on this
   * device and would fight the ChatGPT app for ownership. Never seize.
   */
  open(): void {
    if (this.#open) {
      return;
    }
    const result = bindings().IOHIDDeviceOpen(this.info.handle, kIOHIDOptionsTypeNone);
    if (result !== kIOReturnSuccess) {
      throw new HidError("IOHIDDeviceOpen failed", result);
    }
    this.#open = true;
  }

  /**
   * Write one preframed Report 6 output. USB passes 63 bytes without a report
   * prefix; BLE passes 64 bytes with the 0x06 prefix. The OS report id stays 6
   * for both. A successful return still does not prove firmware delivery.
   */
  setOutputReport(report: Uint8Array): number {
    if (!this.#open) {
      throw new Error("device is not open");
    }
    if (report.length !== 63 && report.length !== 64) {
      throw new Error(`Codex Micro output report must be 63 or 64 bytes, got ${report.length}`);
    }
    const buf = Buffer.from(report.buffer, report.byteOffset, report.byteLength);

    const result = bindings().IOHIDDeviceSetReport(
      this.info.handle,
      kIOHIDReportTypeOutput,
      0x06,
      buf,
      buf.length,
    );
    if (result === kIOReturnSuccess) {
      this.setReportCount++;
    }
    return result;
  }

  /**
   * Register the input-report callback and schedule the device on the main
   * thread's run loop.
   *
   * On macOS this succeeds even without Input Monitoring permission - TCC
   * can withhold reports, not registration. A zero count alone does not prove
   * a permission failure: the device may simply be idle.
   */
  startReading(handler: InputReportHandler): void {
    if (!this.#open) {
      throw new Error("device is not open");
    }
    if (this.#scheduled) {
      return;
    }
    const bound = bindings();

    this.#handler = handler;

    const size = this.info.maxInputReportSize ?? 64;
    this.#inputBuffer = bound.api.alloc("uint8_t", size);

    this.#callbackPtr = bound.api.register(
      (
        _context: unknown,
        _result: number,
        _sender: unknown,
        _type: number,
        reportId: number,
        report: unknown,
        reportLength: number,
      ) => {
        this.inputReportCount++;
        try {
          const length = reportLength;
          if (length < 0 || length > size) {
            return;
          }
          // SAFETY: koffi decodes the declared uint8_t array into numeric bytes.
          const bytes =
            length > 0 && report
              ? Uint8Array.from(bound.api.decode(report, "uint8_t", length))
              : new Uint8Array(0);
          this.#handler?.(reportId, bytes);
        } catch {
          // A throw here would unwind through C. Swallow and keep the run loop alive.
        }
      },
      bound.api.pointer(bound.IOHIDReportCallbackProto),
    );

    bound.IOHIDDeviceRegisterInputReportCallback(
      this.info.handle,
      this.#inputBuffer,
      size,
      this.#callbackPtr,
      null,
    );

    bound.IOHIDDeviceScheduleWithRunLoop(
      this.info.handle,
      bound.CFRunLoopGetCurrent(),
      defaultRunLoopMode(),
    );
    this.#scheduled = true;
  }

  close(): void {
    const bound = cachedBindings;
    if (this.#scheduled && bound) {
      try {
        bound.IOHIDDeviceUnscheduleFromRunLoop(
          this.info.handle,
          bound.CFRunLoopGetCurrent(),
          defaultRunLoopMode(),
        );
      } catch {
        // Teardown is best-effort.
      }
      this.#scheduled = false;
    }
    // Keep the callback and stable buffer alive until IOKit is closed.
    if (this.#open && bound) {
      bound.IOHIDDeviceClose(this.info.handle, kIOHIDOptionsTypeNone);
    }
    this.#open = false;
    if (this.#callbackPtr !== null && bound) {
      try {
        bound.api.unregister(this.#callbackPtr);
      } catch {
        // Teardown is best-effort.
      }
    }
    this.#callbackPtr = null;
    // koffi.alloc uses calloc without a GC finalizer; dropping the pointer leaks.
    if (this.#inputBuffer !== null && bound) {
      bound.api.free(this.#inputBuffer);
    }
    this.#inputBuffer = null;
    this.#handler = null;
  }
}

/**
 * Pump the current thread's CFRunLoop for `seconds`.
 *
 * Node's event loop is not a CFRunLoop, so nothing dispatches IOKit sources
 * unless we do it. Call this in short slices from a timer to stay responsive.
 * Returns the CFRunLoopRunResult (1 finished, 2 stopped, 3 timed out, 4 handled).
 */
export function pump(seconds = 0.005): number {
  return bindings().CFRunLoopRunInMode(defaultRunLoopMode(), seconds, false);
}

/** `kCFRunLoopRunHandledSource` - the pump handled a source and may have more queued. */
export const kCFRunLoopRunHandledSource = 4;

/** Release the shared HID manager. Safe to call more than once. */
export function shutdownManager(): void {
  if (sharedManager !== null) {
    try {
      const bound = bindings();
      bound.IOHIDManagerClose(sharedManager, kIOHIDOptionsTypeNone);
      bound.CFRelease(sharedManager);
    } catch {
      // Teardown is best-effort.
    }
    sharedManager = null;
  }
}
