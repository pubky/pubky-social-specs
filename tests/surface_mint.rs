//! Ids over a sequence of calls on one clock reading, through the surface oracle.
#![cfg(feature = "surface")]

use pubky_social_specs::surface::{call, Arg, Env};

const OWNER: &str = "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
const NOW: i64 = 1_790_000_000_000_000;

fn text(value: &serde_json::Value, member: &str) -> String {
    value[member].as_str().unwrap().to_string()
}

/// An edit made in the instant its post was created gets a salted successor, up to a minute
/// ahead. The post created next, still in that instant, must not get the first post's id: it
/// would be written over the first post's first version.
#[test]
fn a_post_built_after_an_edit_in_the_same_instant_gets_its_own_id() {
    let mut env = Env { now: NOW, last: 0 };
    let owner = Arg::S(OWNER.into());
    let note = |content: &str| Arg::J(format!(r#"{{"content":"{content}"}}"#));
    let stored = |content: &str| {
        Arg::J(format!(
            r#"{{"content":"{content}","kind":"note","parent":null,"embed":null,"attachments":[]}}"#
        ))
    };

    let first = call("createPost", &[owner.clone(), note("a")], &mut env).unwrap();
    let id = text(&first, "id");
    let at = Arg::J(format!(r#"{{"id":"{id}","head":"{id}"}}"#));
    let edit = call(
        "editPost",
        &[owner.clone(), stored("a2"), at.clone()],
        &mut env,
    )
    .unwrap();
    assert!(text(&edit, "editId") > id, "an edit sits above its head");

    let second = call("createPost", &[owner.clone(), note("b")], &mut env).unwrap();
    assert_ne!(text(&second, "id"), id);
    assert!(text(&second, "id") > id);

    // The same edit again lands on the same id, a different one elsewhere
    let again = call(
        "editPost",
        &[owner.clone(), stored("a2"), at.clone()],
        &mut env,
    )
    .unwrap();
    assert_eq!(text(&again, "editId"), text(&edit, "editId"));
    let other = call("editPost", &[owner, stored("a3"), at], &mut env).unwrap();
    assert_ne!(text(&other, "editId"), text(&edit, "editId"));
}
