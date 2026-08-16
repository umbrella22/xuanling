use std::fs::OpenOptions;
use std::process::{Command, Stdio};
use std::time::Duration;

fn main() -> std::io::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let mode = args.next().ok_or_else(|| invalid("missing mode"))?;
    if mode == "print-cwd" {
        println!("{}", std::env::current_dir()?.display());
        return Ok(());
    }
    let lease_path = args
        .next()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| invalid("missing lease path"))?;

    if mode == "leaf" {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lease_path)?;
        file.lock()?;
        std::thread::sleep(Duration::from_secs(120));
        return Ok(());
    }

    if mode != "spawn-and-wait" {
        return Err(invalid("unknown mode"));
    }
    let mut child = Command::new(std::env::current_exe()?)
        .arg("leaf")
        .arg(lease_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    child.wait()?;
    Ok(())
}

fn invalid(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message)
}
