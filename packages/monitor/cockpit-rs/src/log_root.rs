use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub fn git_root_of(cwd: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&output.stdout);
    let root = root.trim();
    (!root.is_empty()).then(|| PathBuf::from(root))
}

pub fn log_root(cwd: &Path, git_root: impl Fn(&Path) -> Option<PathBuf>) -> PathBuf {
    let start = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let Some(root) = git_root(&start) else {
        return start;
    };
    let top = std::fs::canonicalize(&root).unwrap_or(root);
    if start != top && !is_inside(&top, &start) {
        return top;
    }
    let mut dir = start;
    loop {
        if dir.join(".cockpit").is_dir() {
            return dir;
        }
        if dir == top {
            return top;
        }
        let Some(parent) = dir.parent() else {
            return top;
        };
        if parent == dir {
            return top;
        }
        dir = parent.to_path_buf();
    }
}

fn is_inside(root: &Path, target: &Path) -> bool {
    let Ok(relative) = target.strip_prefix(root) else {
        return false;
    };
    // TS rejects every relative path starting with "..", including names such as "..hidden".
    !relative.as_os_str().is_empty()
        && !relative.as_os_str().to_string_lossy().starts_with("..")
        && !relative.is_absolute()
}

pub fn absolute_lexical(path: &Path) -> Option<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(component.as_os_str()),
        }
    }
    Some(result)
}

pub fn resolve_known_project(requested: &str, known: &[String]) -> Option<PathBuf> {
    if requested.is_empty() {
        return None;
    }
    let target = absolute_lexical(Path::new(requested))?;
    let mut best: Option<PathBuf> = None;
    for candidate in known {
        if candidate.is_empty() {
            continue;
        }
        let Some(root) = absolute_lexical(Path::new(candidate)) else {
            continue;
        };
        if root != target && !is_inside(&root, &target) {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|best| root.as_os_str().len() > best.as_os_str().len())
        {
            best = Some(root);
        }
    }
    best
}

pub fn log_path_for(project: &Path, session_id: &str) -> PathBuf {
    project
        .join(".cockpit/logs")
        .join(format!("{session_id}.jsonl"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn fixture() -> TempDir {
        tempfile::Builder::new()
            .prefix("log-root-")
            .tempdir_in(env!("CARGO_MANIFEST_DIR"))
            .unwrap()
    }

    fn mkdir(path: &Path) -> PathBuf {
        fs::create_dir_all(path).unwrap();
        fs::canonicalize(path).unwrap()
    }

    #[test]
    fn walk_up_rules_and_git_root_bound() {
        let temp = fixture();
        let home = fs::canonicalize(temp.path()).unwrap();
        mkdir(&home.join(".cockpit"));
        let repo = mkdir(&home.join("Projects/app"));
        let frontend = mkdir(&repo.join("frontend"));
        let nested = mkdir(&frontend.join("src/components"));
        assert_eq!(log_root(&frontend, |_| Some(repo.clone())), repo);
        assert_eq!(log_root(&repo, |_| Some(repo.clone())), repo);
        assert_eq!(log_root(&nested, |_| Some(repo.clone())), repo);
        fs::write(frontend.join(".cockpit"), "not a dir").unwrap();
        assert_eq!(log_root(&frontend, |_| Some(repo.clone())), repo);
        fs::remove_file(frontend.join(".cockpit")).unwrap();
        mkdir(&repo.join(".cockpit"));
        mkdir(&frontend.join(".cockpit"));
        assert_eq!(log_root(&frontend, |_| Some(repo.clone())), frontend);
        assert_eq!(log_root(&nested, |_| Some(repo.clone())), frontend);
        assert_eq!(
            log_root(&frontend.join("../frontend"), |_| Some(repo.clone())),
            frontend
        );
    }

    #[test]
    fn outside_repo_never_walks_up_and_missing_paths_fall_back() {
        let temp = fixture();
        let parent = fs::canonicalize(temp.path()).unwrap();
        mkdir(&parent.join(".cockpit"));
        let loose = mkdir(&parent.join("loose"));
        assert_eq!(log_root(&loose, |_| None), loose);
        mkdir(&loose.join(".cockpit"));
        assert_eq!(log_root(&loose, |_| None), loose);
        let missing = parent.join("missing");
        assert_eq!(log_root(&missing, |_| None), missing);
        let reported = mkdir(&parent.join("reported/repo"));
        assert_eq!(log_root(&loose, |_| Some(reported.clone())), reported);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_cwd_and_git_root_are_normalized() {
        let temp = fixture();
        let repo = mkdir(&temp.path().join("repo"));
        let frontend = mkdir(&repo.join("frontend"));
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&frontend, &link).unwrap();
        let root_link = temp.path().join("root-link");
        std::os::unix::fs::symlink(&repo, &root_link).unwrap();
        assert_eq!(log_root(&link, |_| Some(root_link.clone())), repo);
        assert_eq!(log_root(&link, |_| None), frontend);
    }

    #[test]
    fn known_project_is_lexical_and_only_resolves_downward() {
        let known: Vec<String> = ["/repo", "/repo/frontend", "/other", ""]
            .into_iter()
            .map(String::from)
            .collect();
        for (requested, expected) in [
            ("/repo", Some("/repo")),
            ("/repo/backend/src", Some("/repo")),
            ("/repo/frontend/src", Some("/repo/frontend")),
            ("/repo-other/src", None),
            ("/elsewhere", None),
            ("", None),
            ("/", None),
            ("/repo/frontend/../backend", Some("/repo")),
            ("/repo/..hidden", None),
        ] {
            assert_eq!(
                resolve_known_project(requested, &known),
                expected.map(PathBuf::from)
            );
        }
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            resolve_known_project("fictional/src/../child", &["fictional".into()]),
            Some(cwd.join("fictional"))
        );
        assert_eq!(
            log_path_for(Path::new("/repo"), "session"),
            PathBuf::from("/repo/.cockpit/logs/session.jsonl")
        );
    }

    fn init_git(repo: &Path) -> bool {
        let output = match Command::new("git").args(["init", "-q"]).arg(repo).output() {
            Ok(output) => output,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("skipping real git test: git is unavailable");
                return false;
            }
            Err(error) => panic!("cannot execute git: {error}"),
        };
        assert!(
            output.status.success(),
            "git init failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }

    #[test]
    fn real_git_root_ignores_cockpit_above_repo() {
        let temp = fixture();
        mkdir(&temp.path().join(".cockpit"));
        let repo = mkdir(&temp.path().join("repo"));
        if !init_git(&repo) {
            return;
        }
        let nested = mkdir(&repo.join("packages/api"));
        assert_eq!(git_root_of(&nested), Some(repo.clone()));
        assert_eq!(log_root(&nested, git_root_of), repo);
        assert_eq!(git_root_of(&temp.path().join("missing")), None);
        // A fresh fixture stays inside this checkout, so mask inherited git discovery with an invalid gitfile.
        let outside = mkdir(&temp.path().join("outside"));
        fs::write(outside.join(".git"), "gitdir: missing\n").unwrap();
        assert_eq!(git_root_of(&outside), None);
    }

    #[test]
    fn linked_worktree_gitfile_resolves_to_worktree() {
        let temp = fixture();
        let repo = mkdir(&temp.path().join("repo"));
        if !init_git(&repo) {
            return;
        }
        let worktree = mkdir(&temp.path().join("worktree"));
        let metadata = mkdir(&repo.join(".git/worktrees/fixture"));
        // Build git's linked-worktree metadata without commits or worktree mutations.
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", metadata.display()),
        )
        .unwrap();
        fs::write(metadata.join("commondir"), "../..\n").unwrap();
        fs::write(metadata.join("HEAD"), "ref: refs/heads/fixture\n").unwrap();
        fs::write(
            metadata.join("gitdir"),
            format!("{}\n", worktree.join(".git").display()),
        )
        .unwrap();
        assert_eq!(git_root_of(&worktree), Some(worktree.clone()));
        assert_eq!(log_root(&worktree, git_root_of), worktree);
    }
}
