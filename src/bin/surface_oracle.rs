//! Answers surface calls over stdin and stdout, one JSON document per line.
//!
//! A request is `{"op", "args", "now", "last"}`; the answer is `{"ok", "last"}` or
//! `{"err", "last"}`. Every request carries its own clock and mint guard, so a recorded
//! request replays to the same answer.

// The surface is native only, so a wasm32 build of every bin gets an empty one
#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> std::io::Result<()> {
    native::main()
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use pubky_social_specs::surface::{call, Arg, Env};
    use serde::Deserialize;
    use serde_json::json;
    use std::io::{self, BufRead, Write};

    #[derive(Deserialize)]
    struct Request {
        op: String,
        #[serde(default)]
        args: Vec<Arg>,
        #[serde(flatten)]
        env: Env,
    }

    pub fn main() -> io::Result<()> {
        let mut out = io::BufWriter::new(io::stdout().lock());
        for line in io::stdin().lock().lines() {
            let line = line?;
            let answer = match serde_json::from_str::<Request>(&line) {
                Ok(mut request) => match call(&request.op, &request.args, &mut request.env) {
                    Ok(ok) => json!({ "ok": ok, "last": request.env.last }),
                    Err(err) => json!({ "err": err, "last": request.env.last }),
                },
                Err(e) => json!({ "err": format!("surface: unreadable request: {e}") }),
            };
            writeln!(out, "{answer}")?;
            out.flush()?;
        }
        Ok(())
    }
}
