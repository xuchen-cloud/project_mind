//! Private session leases survive a SIGKILL of the JavaScript owner. The lease
//! sentinel is outside the command's process group but keeps its session alive.
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
unsafe extern "C" {
    fn fork() -> i32;
    fn setsid() -> i32;
    fn getsid(pid: i32) -> i32;
    fn getpid() -> i32;
    fn getpgrp() -> i32;
    fn setpgid(pid: i32, group: i32) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    fn close(fd: i32) -> i32;
    fn dup2(old: i32, new: i32) -> i32;
    fn getdtablesize() -> i32;
    fn _exit(code: i32) -> !;
}
const EXEC_FLAG: &str = "--dsh-owned-exec";
const GUARDIAN_FLAG: &str = "--dsh-process-guardian";
pub const HELPER_ENV: &str = "PROJECT_MIND_DSH_PROCESS_HELPER";
pub const DIRECTORY_ENV: &str = "PROJECT_MIND_DSH_PROCESS_DIRECTORY";

fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|e| e.into_inner())
}
fn socket(directory: &Path) -> PathBuf {
    directory.join("lease")
}
fn secret(directory: &Path) -> io::Result<String> {
    fs::read_to_string(directory.join("secret"))
}
fn frame(reader: &mut impl Read) -> Result<String> {
    let mut bytes = vec![];
    reader.take(513).read_until_newline(&mut bytes)?;
    if bytes.len() > 512 || bytes.last() != Some(&b'\n') {
        return Err("Invalid DSH lifetime frame".into());
    }
    Ok(String::from_utf8(bytes)?.trim_end_matches('\n').to_owned())
}
trait ReadLine: Read {
    fn read_until_newline(&mut self, bytes: &mut Vec<u8>) -> io::Result<()> {
        loop {
            let mut byte = [0];
            if self.read(&mut byte)? == 0 {
                return Ok(());
            }
            bytes.push(byte[0]);
            if byte[0] == b'\n' {
                return Ok(());
            }
        }
    }
}
impl<T: Read> ReadLine for T {}

pub struct Guardian {
    child: Option<Child>,
    control: Option<ChildStdin>,
    directory: PathBuf,
    executable: PathBuf,
}
impl Guardian {
    pub fn start(executable: &Path) -> Result<Self> {
        let mut random = [0; 16];
        fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let directory = std::env::temp_dir().join(format!("mind-dsh-lease-{token}"));
        fs::create_dir(&directory)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        fs::write(directory.join("secret"), &token)?;
        let mut child = match Command::new(executable)
            .arg(GUARDIAN_FLAG)
            .arg(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                let _ = fs::remove_dir_all(&directory);
                return Err(error.into());
            }
        };
        let stdout = child
            .stdout
            .take()
            .ok_or("Missing guardian readiness pipe")?;
        let (send, receive) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut text = String::new();
            let result = BufReader::new(stdout).read_line(&mut text).map(|_| text);
            let _ = send.send(result);
        });
        if !matches!(receive.recv_timeout(Duration::from_secs(5)), Ok(Ok(text)) if text == "READY\n")
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_dir_all(&directory);
            return Err("DSH lifetime guardian did not become ready".into());
        }
        let control = child.stdin.take();
        Ok(Self {
            child: Some(child),
            control,
            directory,
            executable: executable.into(),
        })
    }
    pub fn wrap(&self, original: &Command) -> Command {
        let mut command = Command::new(&self.executable);
        command
            .arg(EXEC_FLAG)
            .arg(&self.directory)
            .arg("host")
            .arg(original.get_program())
            .args(original.get_args());
        if let Some(cwd) = original.get_current_dir() {
            command.current_dir(cwd);
        }
        for (key, value) in original.get_envs() {
            if let Some(value) = value {
                command.env(key, value);
            } else {
                command.env_remove(key);
            }
        }
        command
            .env(HELPER_ENV, &self.executable)
            .env(DIRECTORY_ENV, &self.directory);
        command
    }
    pub fn finish(&mut self) -> Result<()> {
        self.control.take();
        let until = Instant::now() + Duration::from_secs(5);
        if let Some(child) = self.child.as_mut() {
            loop {
                if let Some(status) = child.try_wait()? {
                    self.child.take();
                    fs::remove_dir_all(&self.directory)?;
                    if !status.success() {
                        return Err("DSH lifetime guardian failed cleanup".into());
                    }
                    return Ok(());
                }
                if Instant::now() >= until {
                    return Err("DSH lifetime cleanup did not finish".into());
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
        Ok(())
    }
}
impl Drop for Guardian {
    fn drop(&mut self) {
        self.control.take();
        if let Some(mut child) = self.child.take() {
            let directory = self.directory.clone();
            thread::spawn(move || {
                let _ = child.wait();
                let _ = fs::remove_dir_all(directory);
            });
        }
    }
}

struct Registry {
    stopped: AtomicBool,
    failed: AtomicBool,
    leases: Mutex<HashMap<i32, UnixStream>>,
    pins: Mutex<HashMap<i32, i32>>,
    observer: Mutex<Option<UnixStream>>,
    directory: PathBuf,
}
impl Registry {
    fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        for lease in lock(&self.leases).values_mut() {
            let _ = lease.write_all(b"STOP\n");
        }
        if let Some(observer) = lock(&self.observer).as_ref() {
            let _ = observer.shutdown(std::net::Shutdown::Both);
        }
        let _ = UnixStream::connect(socket(&self.directory));
    }
    fn publish(&self, kind: &str, root: i32, guard: i32) -> io::Result<()> {
        if let Some(observer) = lock(&self.observer).as_mut() {
            writeln!(observer, "{kind} {root} {guard}")?;
        }
        Ok(())
    }
}
fn connection(mut stream: UnixStream, registry: &Arc<Registry>, token: &str) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let request = frame(&mut stream)?;
    stream.set_read_timeout(None)?;
    let parts: Vec<_> = request.split(' ').collect();
    if parts.get(1).copied() != Some(token) {
        return Err("Invalid DSH lifetime credential".into());
    }
    if parts.first() == Some(&"WATCH") && parts.len() == 2 {
        let mut observer = lock(&registry.observer);
        if observer.is_some() {
            return Err("DSH lifetime observer already connected".into());
        }
        writeln!(stream, "OK")?;
        for (&root, &guard) in lock(&registry.pins).iter() {
            writeln!(stream, "PIN {root} {guard}")?;
        }
        *observer = Some(stream.try_clone()?);
        drop(observer);
        let mut byte = [0];
        let read = stream.read(&mut byte);
        registry.stop();
        read?;
        return Ok(());
    }
    if parts.first() != Some(&"PIN") || parts.len() != 6 {
        return Err("Invalid DSH session lease".into());
    }
    let root: i32 = parts[2].parse()?;
    let guard: i32 = parts[3].parse()?;
    let session: i32 = parts[4].parse()?;
    let host = parts[5] == "host";
    if root <= 1 || guard <= 1 || root != session || !matches!(parts[5], "host" | "tool") {
        return Err("Invalid private DSH session".into());
    }
    {
        let mut leases = lock(&registry.leases);
        if registry.stopped.load(Ordering::SeqCst) {
            return Err("DSH lifetime ended".into());
        }
        if leases.len() >= 256 {
            return Err("DSH owned process budget exhausted".into());
        }
        leases.insert(guard, stream.try_clone()?);
        lock(&registry.pins).insert(root, guard);
    }
    registry.publish("PIN", root, guard)?;
    fs::write(registry.directory.join(format!("ready-{root}")), b"ready")?;
    writeln!(stream, "OK")?;
    let read = frame(&mut stream);
    if !matches!(&read, Ok(message) if message == "DONE") {
        registry.failed.store(true, Ordering::SeqCst);
        registry.stop();
    }
    lock(&registry.leases).remove(&guard);
    lock(&registry.pins).remove(&root);
    let _ = registry.publish("GONE", root, guard);
    if host {
        registry.stop();
    }
    read?;
    Ok(())
}
fn guardian(directory: &Path) -> Result<()> {
    let token = secret(directory)?;
    let listener = UnixListener::bind(socket(directory))?;
    let registry = Arc::new(Registry {
        stopped: AtomicBool::new(false),
        failed: AtomicBool::new(false),
        leases: Mutex::new(HashMap::new()),
        pins: Mutex::new(HashMap::new()),
        observer: Mutex::new(None),
        directory: directory.into(),
    });
    let control = registry.clone();
    thread::spawn(move || {
        let mut byte = [0];
        let _ = io::stdin().read(&mut byte);
        control.stop();
    });
    println!("READY");
    io::stdout().flush()?;
    let mut handlers = vec![];
    for stream in listener.incoming() {
        let stream = stream?;
        if registry.stopped.load(Ordering::SeqCst) {
            break;
        }
        let state = registry.clone();
        let token = token.clone();
        handlers.retain(|handler: &thread::JoinHandle<()>| !handler.is_finished());
        if handlers.len() >= 258 {
            drop(stream);
            continue;
        }
        handlers.push(thread::spawn(move || {
            if let Err(error) = connection(stream, &state, &token) {
                if !state.stopped.load(Ordering::SeqCst) {
                    eprintln!("DSH lifetime connection: {error}");
                }
            }
        }));
    }
    registry.stop();
    for handler in handlers {
        if handler.join().is_err() {
            registry.failed.store(true, Ordering::SeqCst);
        }
    }
    if registry.failed.load(Ordering::SeqCst) {
        return Err("DSH session did not confirm cleanup".into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Member {
    pid: i32,
    group: i32,
}
fn members(session: i32, sentinel: i32) -> Result<Vec<Member>> {
    // This is called on process exit or teardown, never by an idle timer.
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,pgid=,stat="])
        .output()?;
    if !output.status.success() {
        return Err("Cannot inspect owned DSH session".into());
    }
    let mut members = vec![];
    for line in String::from_utf8(output.stdout)?.lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(group), Some(state)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(group)) = (pid.parse::<i32>(), group.parse::<i32>()) else {
            continue;
        };
        if pid != sentinel && !state.starts_with(['Z', 'X']) && unsafe { getsid(pid) } == session {
            members.push(Member { pid, group });
        }
    }
    Ok(members)
}
fn reap(pid: i32, options: i32) -> Result<i32> {
    let mut status = 0;
    loop {
        let result = unsafe { waitpid(pid, &mut status, options) };
        if result >= 0 {
            return Ok(status);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error.into());
        }
    }
}
struct FrozenGroups(HashMap<i32, i32>);
impl Drop for FrozenGroups {
    fn drop(&mut self) {
        for (&group, &child) in &self.0 {
            unsafe {
                kill(-group, 9);
            }
            let _ = reap(child, 0);
        }
    }
}
#[cfg(target_os = "macos")]
const SIGSTOP: i32 = 17;
#[cfg(target_os = "linux")]
const SIGSTOP: i32 = 19;
fn stop_session(session: i32, sentinel: i32) -> Result<()> {
    if unsafe { getsid(0) } != session {
        return Err("DSH session identity changed".into());
    }
    let own_group = unsafe { getpgrp() };
    let mut held = FrozenGroups(HashMap::new());
    loop {
        let groups: HashSet<_> = members(session, sentinel)?
            .into_iter()
            .map(|m| m.group)
            .filter(|group| *group != own_group)
            .collect();
        let pending: Vec<_> = groups
            .into_iter()
            .filter(|group| !held.0.contains_key(group))
            .collect();
        if pending.is_empty() {
            break;
        }
        for group in pending {
            let child = unsafe { fork() };
            if child < 0 {
                return Err(io::Error::last_os_error().into());
            }
            if child == 0 {
                unsafe {
                    // setpgid is the atomic ownership fence. A recycled group from
                    // another session cannot be joined. Our stopped child then pins
                    // this group until the controller signals and reaps it.
                    if setpgid(0, group) != 0 {
                        _exit(0);
                    }
                    kill(0, SIGSTOP);
                    _exit(0);
                }
            }
            let status = reap(child, 2)?; // WUNTRACED
            if status & 0xff == 0x7f {
                held.0.insert(group, child);
            }
        }
    }
    drop(held);
    Ok(())
}

#[cfg(target_os = "macos")]
fn await_change(lease: &UnixStream, pids: &[i32]) -> Result<bool> {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Event {
        ident: usize,
        filter: i16,
        flags: u16,
        fflags: u32,
        data: isize,
        udata: *mut std::ffi::c_void,
    }
    unsafe extern "C" {
        fn kqueue() -> i32;
        fn kevent(
            queue: i32,
            changes: *const Event,
            count: i32,
            events: *mut Event,
            capacity: i32,
            timeout: *const std::ffi::c_void,
        ) -> i32;
    }
    let raw = unsafe { kqueue() };
    if raw < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let queue = unsafe { OwnedFd::from_raw_fd(raw) };
    let event = |ident, filter, fflags| Event {
        ident,
        filter,
        flags: 0x1 | 0x4 | 0x10,
        fflags,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    let mut changes = vec![event(lease.as_raw_fd() as usize, -1, 0)];
    changes.extend(pids.iter().map(|pid| event(*pid as usize, -5, 0x80000000)));
    let mut observed = event(0, 0, 0);
    loop {
        let result = unsafe {
            kevent(
                queue.as_raw_fd(),
                changes.as_ptr(),
                changes.len() as i32,
                &mut observed,
                1,
                std::ptr::null(),
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        if observed.flags & 0x4000 != 0 && observed.data != 0 {
            if observed.data == 3 {
                return Ok(false);
            } // ESRCH: snapshot after exit.
            return Err(io::Error::from_raw_os_error(observed.data as i32).into());
        }
        return Ok(observed.filter == -1);
    }
}
#[cfg(target_os = "linux")]
fn await_change(lease: &UnixStream, pids: &[i32]) -> Result<bool> {
    #[repr(C)]
    struct Poll {
        fd: i32,
        events: i16,
        revents: i16,
    }
    unsafe extern "C" {
        fn syscall(number: isize, ...) -> isize;
        fn poll(fds: *mut Poll, count: usize, timeout: i32) -> i32;
    }
    let mut owned = vec![];
    for pid in pids {
        let fd = unsafe { syscall(434, *pid, 0) } as i32;
        if fd < 0 {
            if io::Error::last_os_error().raw_os_error() == Some(3) {
                return Ok(false);
            }
            return Err(io::Error::last_os_error().into());
        }
        owned.push(unsafe { OwnedFd::from_raw_fd(fd) });
    }
    let mut fds = vec![Poll {
        fd: lease.as_raw_fd(),
        events: 1,
        revents: 0,
    }];
    fds.extend(owned.iter().map(|fd| Poll {
        fd: fd.as_raw_fd(),
        events: 1,
        revents: 0,
    }));
    loop {
        let result = unsafe { poll(fds.as_mut_ptr(), fds.len(), -1) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        return Ok(fds[0].revents != 0);
    }
}
fn sentinel(directory: &Path, root: i32, session: i32, role: &str) -> Result<()> {
    let pid = unsafe { getpid() };
    if unsafe { setpgid(0, 0) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    // Do not retain command output/control endpoints or affect EOF/drain.
    let null = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/null")?;
    for fd in 0..=2 {
        if unsafe { dup2(null.as_raw_fd(), fd) } < 0 {
            return Err(io::Error::last_os_error().into());
        }
    }
    drop(null);
    // The bootstrap is single threaded. Retaining provider IPC fd 3/4 here
    // would keep a killed host's channel and guardian control pipe alive.
    for fd in 3..unsafe { getdtablesize() } {
        unsafe {
            close(fd);
        }
    }
    let mut lease = UnixStream::connect(socket(directory))?;
    writeln!(
        lease,
        "PIN {} {root} {pid} {session} {role}",
        secret(directory)?
    )?;
    if frame(&mut lease)? != "OK" {
        return Err("Cannot register DSH session".into());
    }
    let mut waiting = vec![root];
    let result = loop {
        if await_change(&lease, &waiting)? {
            break stop_session(session, pid);
        }
        if role == "host" {
            break stop_session(session, pid);
        }
        let alive = members(session, pid)?;
        if alive.is_empty() {
            break Ok(());
        }
        waiting = alive.into_iter().map(|member| member.pid).collect();
    };
    if result.is_ok() {
        writeln!(lease, "DONE")?;
    }
    result
}

fn execute(directory: &Path, role: &str, argv: &[std::ffi::OsString]) -> Result<()> {
    if argv.is_empty() || !matches!(role, "host" | "tool") {
        return Err("Invalid DSH owned launch".into());
    }
    let root = unsafe { getpid() };
    if unsafe { getsid(0) } != root && unsafe { setsid() } < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let session = unsafe { getsid(0) };
    // Bootstrap and double-fork before exec: no target code runs before its
    // lease exists, and the target never inherits an unknown child to reap.
    let child = unsafe { fork() };
    if child < 0 {
        return Err(io::Error::last_os_error().into());
    }
    if child == 0 {
        let guard = unsafe { fork() };
        if guard < 0 {
            unsafe { _exit(1) };
        }
        if guard == 0 {
            let code = match sentinel(directory, root, session, role) {
                Ok(()) => 0,
                Err(_) => {
                    let _ = stop_session(session, unsafe { getpid() });
                    1
                }
            };
            unsafe { _exit(code) };
        }
        unsafe { _exit(0) };
    }
    if reap(child, 0)? != 0 {
        return Err("Cannot start DSH session sentinel".into());
    }
    // Registration readiness is separate from the lease stream: the guardian
    // atomically publishes this marker before acknowledging the sentinel.
    let ready = directory.join(format!("ready-{root}"));
    let until = Instant::now() + Duration::from_secs(5);
    while !ready.exists() {
        if Instant::now() >= until {
            return Err("DSH session lease did not register".into());
        }
        thread::sleep(Duration::from_millis(2));
    }
    fs::remove_file(ready)?;
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]);
    if role == "tool" {
        command.env_remove(HELPER_ENV).env_remove(DIRECTORY_ENV);
    }
    Err(command.exec().into())
}
pub fn helper_main() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    let flag = args.next()?;
    if flag != EXEC_FLAG && flag != GUARDIAN_FLAG {
        return None;
    }
    let result = (|| -> Result<()> {
        let directory = args.next().ok_or("Missing DSH lifetime directory")?;
        if flag == GUARDIAN_FLAG {
            guardian(Path::new(&directory))
        } else {
            let role = args.next().ok_or("Missing DSH lifetime role")?;
            execute(
                Path::new(&directory),
                role.to_str().ok_or("Invalid DSH role")?,
                &args.collect::<Vec<_>>(),
            )
        }
    })();
    Some(match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("DSH process lifetime: {error}");
            1
        }
    })
}
