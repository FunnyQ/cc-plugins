pub fn is_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // Signal zero only checks existence and permission; it never sends a signal.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn wait_for_exit(pid: i32, timeout: std::time::Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline && is_alive(pid) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// SIGTERM, then SIGKILL after 1.5 s; returns once the pid is gone or 1 s after the kill.
pub fn terminate(pid: i32) {
    // Only a pid read from the daemon record reaches here; a failed signal means it already exited.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return;
    }
    wait_for_exit(pid, std::time::Duration::from_millis(1500));
    if is_alive(pid) {
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        wait_for_exit(pid, std::time::Duration::from_millis(1000));
    }
}

/// setsid detaches a spawned child from the caller's terminal and process group.
pub fn detach(command: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        })
    }
}

// A long-lived parent must wait() its child: a zombie still answers kill(pid, 0), so it would read as alive.
pub fn reap_in_background(mut child: std::process::Child) {
    let _ = std::thread::Builder::new()
        .stack_size(64 * 1024)
        .spawn(move || child.wait());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaped_child_reads_dead_once_killed() {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        reap_in_background(child);
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while is_alive(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            !is_alive(pid),
            "an unreaped zombie still answers kill(pid, 0)"
        );
    }

    #[test]
    fn exited_process_is_not_alive() {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id() as i32;
        child.wait().unwrap();
        assert!(!is_alive(pid));
    }

    #[test]
    fn current_process_is_alive_and_process_group_ids_are_rejected() {
        assert!(is_alive(std::process::id() as i32));
        for pid in [0, -1, -2, i32::MIN, i32::MAX] {
            assert!(!is_alive(pid), "{pid}");
        }
    }
}
