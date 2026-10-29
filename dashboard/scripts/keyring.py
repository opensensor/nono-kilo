#!/usr/bin/python3
"""Private stdin/stdout bridge to Linux Secret Service; never pass secrets in argv."""
import json
import os
import re
import sys

def locked_message():
    if os.path.exists('/proc/sys/fs/binfmt_misc/WSLInterop'):
        return "In WSL, open Passwords and Keys (run seahorse), unlock the default keyring, then retry."
    try:
        with open('/proc/version', encoding='utf-8') as proc:
            if 'microsoft' in proc.read().lower():
                return "In WSL, open Passwords and Keys (run seahorse), unlock the default keyring, then retry."
    except OSError:
        pass
    return "Unlock the default keyring in your desktop password manager, then retry."

def main():
    import gi
    gi.require_version("Secret", "1")
    from gi.repository import Secret
    request = json.load(sys.stdin)
    service = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS, None)
    collection = Secret.Collection.for_alias_sync(service, "default", Secret.CollectionFlags.NONE, None)
    available = collection is not None
    locked = collection.get_locked() if collection else True
    if request.get("action") == "status":
        return {"available": available, "locked": locked, "backend": "GNOME Keyring / Secret Service"}
    if not available:
        return {"error": "Secret Service has no default keyring. Create one in your desktop password manager, then retry."}
    if locked:
        return {"error": locked_message()}
    account = request.get("id", "")
    if not re.fullmatch(r"[a-f0-9]{32}", account):
        return {"error": "Invalid secret identifier."}
    schema = Secret.Schema.new("sh.opensensor.KiloDashboard", Secret.SchemaFlags.NONE, {
        "service": Secret.SchemaAttributeType.STRING,
        "username": Secret.SchemaAttributeType.STRING,
        "target": Secret.SchemaAttributeType.STRING,
    })
    attributes = {"service": "opensensor-nono-dashboard", "username": account, "target": "default"}
    action = request.get("action")
    if action == "put":
        value = request.get("value")
        if not isinstance(value, str) or not 8 <= len(value) <= 16384 or "\0" in value:
            return {"error": "Secrets must contain 8–16,384 characters without NUL bytes."}
        if not Secret.password_store_sync(schema, attributes, Secret.COLLECTION_DEFAULT, "OpenSensor Kilo: " + request.get("name", account)[:100], value, None):
            return {"error": "The system keyring did not save the secret. Retry after unlocking it."}
        return {"ok": True}
    if action == "get":
        value = Secret.password_lookup_sync(schema, attributes, None)
        return {"value": value} if value is not None else {"error": "Secret is missing from the system keyring."}
    if action == "delete":
        Secret.password_clear_sync(schema, attributes, None)
        return {"ok": True}
    return {"error": "Unknown keyring operation."}

try:
    print(json.dumps(main()))
except Exception:
    # Library failures may contain credential-related arguments. Do not echo them.
    print(json.dumps({"error": "Secret Service is unavailable. Check your desktop keyring."}))
    sys.exit(1)
