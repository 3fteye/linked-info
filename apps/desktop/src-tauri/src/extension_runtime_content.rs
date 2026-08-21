const MARKER_OPENING_PREFIX: &str = "[[li:";
const MARKER_CLOSING: &str = "[[/li]]";

struct MarkerOpening {
    end: usize,
    id: String,
    note: Option<String>,
}

fn marker_character(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
}

fn quoted_attribute_end(source: &str, start: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index = index.saturating_add(2),
            b'"' => return Some(index + 1),
            b'\r' | b'\n' => return None,
            _ => index += 1,
        }
    }
    None
}

fn malformed_opening(source: &str, cursor: usize, id: String) -> Option<MarkerOpening> {
    source[cursor..].find("]]").map(|offset| MarkerOpening {
        end: cursor + offset + 2,
        id,
        note: None,
    })
}

fn parse_opening(source: &str, start: usize) -> Option<MarkerOpening> {
    if !source[start..].starts_with(MARKER_OPENING_PREFIX) {
        return None;
    }
    let bytes = source.as_bytes();
    let id_start = start + MARKER_OPENING_PREFIX.len();
    let mut cursor = id_start;
    while cursor < bytes.len() && marker_character(bytes[cursor]) {
        cursor += 1;
    }
    if cursor == id_start || !bytes[id_start].is_ascii_lowercase() {
        return None;
    }
    let id = source[id_start..cursor].to_owned();
    let mut note = None;
    let mut names = std::collections::BTreeSet::new();
    loop {
        if source[cursor..].starts_with("]]") {
            return Some(MarkerOpening {
                end: cursor + 2,
                id,
                note,
            });
        }
        if bytes.get(cursor) != Some(&b' ') {
            return malformed_opening(source, cursor, id);
        }
        while bytes.get(cursor) == Some(&b' ') {
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < bytes.len() && marker_character(bytes[cursor]) {
            cursor += 1;
        }
        if cursor == name_start
            || !bytes[name_start].is_ascii_lowercase()
            || bytes.get(cursor) != Some(&b'=')
        {
            return malformed_opening(source, cursor, id);
        }
        let name = &source[name_start..cursor];
        cursor += 1;
        if bytes.get(cursor) != Some(&b'"') || !names.insert(name.to_owned()) {
            return malformed_opening(source, cursor, id);
        }
        let Some(value_end) = quoted_attribute_end(source, cursor) else {
            return malformed_opening(source, cursor, id);
        };
        let Ok(value) = serde_json::from_str::<String>(&source[cursor..value_end]) else {
            return malformed_opening(source, cursor, id);
        };
        if name == "note" {
            note = Some(value);
        }
        cursor = value_end;
    }
}

fn closing_index(source: &str, payload_start: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut index = payload_start;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            if bytes.get(index + 1) == Some(&b'\\') {
                index += 2;
                continue;
            }
            if source[index + 1..].starts_with(MARKER_CLOSING) {
                index += 1 + MARKER_CLOSING.len();
                continue;
            }
        }
        if source[index..].starts_with(MARKER_CLOSING) {
            return Some(index);
        }
        index += source[index..].chars().next()?.len_utf8();
    }
    None
}

fn strip_sensitive_markers(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0;
    while let Some(offset) = source[cursor..].find(MARKER_OPENING_PREFIX) {
        let start = cursor + offset;
        let Some(opening) = parse_opening(source, start) else {
            let next = start + MARKER_OPENING_PREFIX.len();
            output.push_str(&source[cursor..next]);
            cursor = next;
            continue;
        };
        if opening.id != "secret" && opening.id != "totp" {
            output.push_str(&source[cursor..opening.end]);
            cursor = opening.end;
            continue;
        }
        output.push_str(&source[cursor..start]);
        if let Some(note) = opening
            .note
            .as_deref()
            .map(str::trim)
            .filter(|note| !note.is_empty())
        {
            output.push_str(note);
        }
        let Some(payload_end) = closing_index(source, opening.end) else {
            return output;
        };
        cursor = payload_end + MARKER_CLOSING.len();
    }
    output.push_str(&source[cursor..]);
    output
}

fn legacy_totp_line(line: &str) -> bool {
    let trimmed = line.trim();
    let Some(prefix) = trimmed.get(..4) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("totp") {
        return false;
    }
    let remaining = trimmed[4..].trim_start();
    remaining.starts_with(':') || remaining.starts_with('：')
}

fn strip_legacy_totp_lines(source: &str) -> String {
    source
        .split_inclusive('\n')
        .map(|line| {
            let (content, newline) = line
                .strip_suffix('\n')
                .map_or((line, ""), |content| (content, "\n"));
            if legacy_totp_line(content.trim_end_matches('\r')) {
                newline
            } else {
                line
            }
        })
        .collect()
}

pub fn content_for_extension_runtime(content: &str) -> String {
    strip_legacy_totp_lines(&strip_sensitive_markers(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_inline_and_legacy_secrets_but_keeps_notes_and_layout() {
        let source = [
            r#"password [[li:secret note="OpenAI login"]]synthetic-password[[/li]]"#,
            "TOTP: JBSW Y3DP EHPK 3PXP",
            "ordinary note",
        ]
        .join("\n");

        let sanitized = content_for_extension_runtime(&source);

        assert_eq!(
            sanitized,
            ["password OpenAI login", "", "ordinary note"].join("\n")
        );
        assert!(!sanitized.contains("synthetic-password"));
        assert!(!sanitized.contains("JBSW"));
    }

    #[test]
    fn strips_malformed_known_markers_and_never_guesses_unknown_markers() {
        let malformed = "before [[li:secret note=broken]]synthetic[[/li]] after";
        let unknown = "before [[li:coupon]]VISIBLE[[/li]] after";
        let unclosed = "before [[li:totp]]synthetic";

        assert_eq!(content_for_extension_runtime(malformed), "before  after");
        assert_eq!(content_for_extension_runtime(unknown), unknown);
        assert_eq!(content_for_extension_runtime(unclosed), "before ");
    }

    #[test]
    fn escaped_closing_marker_does_not_end_the_protected_payload() {
        let source = r#"[[li:secret]]before \[[/li]] after[[/li]] retained"#;
        assert_eq!(content_for_extension_runtime(source), " retained");
    }
}
