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

#[cfg(test)]
mod tests {
    use super::*;

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
