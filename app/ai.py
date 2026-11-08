"""Rapprochement des noms par IA (facultatif), multi-fournisseurs.

Réglages (écran Paramètres, table ``settings``) : ``ai_provider`` (openai | google | anthropic | off),
``ai_model``, ``ai_effort`` et une clé par fournisseur (``ai_key_<fournisseur>``, jamais renvoyée au
navigateur). À défaut, les variables d'environnement OPENAI_API_KEY, GEMINI_API_KEY / GOOGLE_API_KEY,
ANTHROPIC_API_KEY sont utilisées. La liste des modèles est lue en direct chez le fournisseur : un nouveau
modèle est utilisable sans redéployer l'application.

Seuls des noms de personnes sont envoyés (jamais de montants). Toute erreur renvoie au rapprochement local.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time

import httpx

log = logging.getLogger(__name__)

PROVIDERS = {
    "openai": {"label": "OpenAI", "env": ["OPENAI_API_KEY"], "default_model": "gpt-4o-mini",
               "efforts": ["none", "minimal", "low", "medium", "high", "xhigh"]},
    "google": {"label": "Google", "env": ["GEMINI_API_KEY", "GOOGLE_API_KEY"], "default_model": "gemini-2.5-flash",
               "efforts": ["low", "medium", "high"]},
    "anthropic": {"label": "Anthropic", "env": ["ANTHROPIC_API_KEY"], "default_model": "claude-opus-5-5",
                  "efforts": ["low", "medium", "high", "xhigh", "max"]},
}
URLS = {
    "openai": os.environ.get("FACTU_OPENAI_URL", "https://api.openai.com/v1"),
    "google": "https://generativelanguage.googleapis.com/v1beta",
    "anthropic": "https://api.anthropic.com/v1",
}

SCHEMA = {
    "type": "object",
    "properties": {
        "matches": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "input": {"type": "string"},
                    "match": {"type": ["string", "null"]},
                    "confidence": {"type": "number"},
                    "reason": {"type": "string"},
                },
                "required": ["input", "match", "confidence", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["matches"],
    "additionalProperties": False,
}

# Réglages lus via la base (branché par app.main) ; vide par défaut (tests, scripts)
settings_getter = lambda: {}  # noqa: E731
transport = None               # remplaçable dans les tests (httpx.MockTransport)
anthropic_transport = None     # idem pour le SDK Anthropic (qui peut s'appuyer sur httpx2)


def _anthropic_client(key: str, timeout: int):
    import anthropic
    if anthropic_transport is None:
        return anthropic.Anthropic(api_key=key, timeout=timeout)
    mod = __import__(type(anthropic_transport).__module__.split(".")[0])
    return anthropic.Anthropic(api_key=key, timeout=timeout,
                               http_client=mod.Client(timeout=timeout, transport=anthropic_transport))


# --------------------------------------------------------------------------- configuration
def key_info(provider: str, s: dict | None = None) -> tuple[str, str | None]:
    """(clé, origine) — origine : 'db', le nom de la variable d'environnement, ou None."""
    s = settings_getter() if s is None else s
    k = (s.get(f"ai_key_{provider}") or "").strip()
    if k:
        return k, "db"
    for env in PROVIDERS[provider]["env"]:
        if os.environ.get(env):
            return os.environ[env], env
    return "", None


def config(s: dict | None = None) -> dict:
    s = settings_getter() if s is None else s
    p = (s.get("ai_provider") or "").strip().lower()
    if p == "off":
        return {"provider": None}
    if p not in PROVIDERS:   # automatique : premier fournisseur ayant une clé
        p = next((x for x in ("anthropic", "openai", "google") if key_info(x, s)[0]), None)
    if not p or not key_info(p, s)[0]:
        return {"provider": None}
    return {"provider": p, "key": key_info(p, s)[0],
            "model": (s.get("ai_model") or "").strip() if (s.get("ai_provider") or "") == p else PROVIDERS[p]["default_model"],
            "effort": (s.get("ai_effort") or "").strip() if (s.get("ai_provider") or "") == p else ""}


def enabled() -> bool:
    return config()["provider"] is not None


def label() -> str:
    c = config()
    if not c["provider"]:
        return ""
    model = c["model"] or PROVIDERS[c["provider"]]["default_model"]
    return f"{PROVIDERS[c['provider']]['label']} ({model}{', raisonnement ' + c['effort'] if c['effort'] else ''})"


# --------------------------------------------------------------------------- modèles disponibles
def list_models(provider: str, key: str) -> list[dict]:
    """Modèles de génération de texte disponibles pour cette clé, les plus récents d'abord."""
    with httpx.Client(timeout=30, transport=transport) as c:
        if provider == "openai":
            r = c.get(f"{URLS['openai']}/models", headers={"Authorization": f"Bearer {key}"})
            r.raise_for_status()
            skip = ("embedding", "tts", "whisper", "dall-e", "image", "audio", "realtime", "transcribe",
                    "moderation", "search", "davinci", "babbage", "sora", "computer-use")
            out = [{"id": m["id"], "label": m["id"], "created": m.get("created") or 0} for m in r.json().get("data", [])
                   if re.match(r"^(gpt|o\d|chatgpt)", m["id"]) and not any(x in m["id"] for x in skip)]
        elif provider == "google":
            out, token = [], None
            while True:
                r = c.get(f"{URLS['google']}/models", headers={"x-goog-api-key": key},
                          params={"pageSize": 1000, **({"pageToken": token} if token else {})})
                r.raise_for_status()
                j = r.json()
                for m in j.get("models", []):
                    mid = m["name"].removeprefix("models/")
                    if "generateContent" in m.get("supportedGenerationMethods", []) and "gemini" in mid \
                            and not any(x in mid for x in ("embedding", "tts", "image", "live", "audio")):
                        out.append({"id": mid, "label": m.get("displayName") or mid, "created": 0})
                token = j.get("nextPageToken")
                if not token:
                    break
            out.sort(key=lambda m: m["id"], reverse=True)
            return out
        elif provider == "anthropic":
            client = _anthropic_client(key, 30)
            out = [{"id": m.id, "label": m.display_name or m.id, "created": str(m.created_at)}
                   for m in client.models.list(limit=1000)]
        else:
            raise ValueError("Fournisseur inconnu")
    out.sort(key=lambda m: str(m["created"]), reverse=True)
    return out


# --------------------------------------------------------------------------- appels
def _prompt(unknown: list[str], canonical: list[str]) -> str:
    return (
        "Tu rapproches des noms de collaborateurs écrits de façon variable (export Jira, fichier de paie, "
        "saisie manuelle) avec la liste officielle des collaborateurs d'une entreprise.\n"
        "Pour chaque nom à rapprocher, indique le nom officiel correspondant s'il s'agit clairement de la même "
        "personne (fautes de frappe, ordre prénom/nom inversé, translittération hébreu/russe/français, initiale, "
        "identifiant de type prenom.nom ou e-mail). Si aucun nom officiel ne correspond, renvoie null : "
        "c'est probablement un nouveau collaborateur. Ne devine pas entre deux personnes plausibles.\n"
        'Réponds uniquement en JSON : {"matches": [{"input": "...", "match": "nom officiel ou null", '
        '"confidence": 0.0-1.0, "reason": "..."}]}\n\n'
        f"Liste officielle :\n{json.dumps(canonical, ensure_ascii=False)}\n\n"
        f"Noms à rapprocher :\n{json.dumps(unknown, ensure_ascii=False)}"
    )


def _parse(text: str) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text or "", re.S)
        if not m:
            raise
        return json.loads(m.group(0))


def _post_with_fallbacks(client: httpx.Client, url: str, headers: dict, bodies: list[dict]) -> httpx.Response:
    """Essaie les variantes de requête de la plus complète à la plus simple (paramètres non pris en charge)."""
    r = None
    for body in bodies:
        r = client.post(url, headers=headers, json=body)
        if r.status_code != 400:
            break
    return r


def _call(c: dict, prompt: str) -> dict:
    p, key, model, effort = c["provider"], c["key"], c["model"] or PROVIDERS[c["provider"]]["default_model"], c["effort"]
    with httpx.Client(timeout=120, transport=transport) as client:
        if p == "openai":
            base = {"model": model, "messages": [{"role": "user", "content": prompt}]}
            schema = {"response_format": {"type": "json_schema",
                                          "json_schema": {"name": "rapprochement_noms", "strict": True, "schema": SCHEMA}}}
            bodies = ([{**base, **schema, "reasoning_effort": effort}] if effort else []) + \
                     [{**base, **schema}, {**base, "response_format": {"type": "json_object"}}, base]
            r = _post_with_fallbacks(client, f"{URLS['openai']}/chat/completions",
                                     {"Authorization": f"Bearer {key}"}, bodies)
            r.raise_for_status()
            msg = r.json()["choices"][0]["message"]
            if msg.get("refusal") or not msg.get("content"):
                raise ValueError("réponse vide ou refusée")
            return _parse(msg["content"])
        if p == "google":
            gen = {"responseMimeType": "application/json"}
            budgets = {"low": 1024, "medium": 8192, "high": 24576}
            base = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
            bodies = ([{**base, "generationConfig": {**gen, "thinkingConfig": {"thinkingLevel": effort}}},
                       {**base, "generationConfig": {**gen, "thinkingConfig": {"thinkingBudget": budgets.get(effort, 8192)}}}]
                      if effort else []) + [{**base, "generationConfig": gen}, base]
            r = _post_with_fallbacks(client, f"{URLS['google']}/models/{model}:generateContent",
                                     {"x-goog-api-key": key}, bodies)
            r.raise_for_status()
            parts = r.json()["candidates"][0]["content"]["parts"]
            return _parse("".join(x.get("text", "") for x in parts if not x.get("thought")))
        if p == "anthropic":
            import anthropic
            sdk = _anthropic_client(key, 120)
            base = {"model": model, "max_tokens": 16000, "messages": [{"role": "user", "content": prompt}]}
            fmt = {"format": {"type": "json_schema", "schema": SCHEMA}}
            variants = ([{**base, "output_config": {"effort": effort, **fmt}}] if effort else []) + \
                       [{**base, "output_config": fmt}, base]
            for i, body in enumerate(variants):
                try:
                    resp = sdk.messages.create(**body)
                    break
                except anthropic.BadRequestError:
                    if i == len(variants) - 1:
                        raise
            if resp.stop_reason == "refusal":
                raise ValueError("réponse refusée")
            return _parse("".join(b.text for b in resp.content if b.type == "text"))
    raise ValueError("Fournisseur inconnu")


def match_names(unknown: list[str], canonical: list[str], cfg: dict | None = None, raise_errors: bool = False) -> dict[str, dict]:
    """Renvoie {nom inconnu: {name, score, reason}} ; {} si l'IA est indisponible."""
    c = cfg or config()
    if not c.get("provider") or not unknown or not canonical:
        return {}
    try:
        data = _call(c, _prompt(unknown, canonical))
    except Exception as e:  # erreurs réseau, API (SDK compris) ou réponse illisible
        if raise_errors:
            raise
        log.warning("IA indisponible (%s) : rapprochement local seulement", e)
        return {}
    allowed = set(canonical)
    out = {}
    for m in data.get("matches", []):
        if m.get("match") in allowed and m.get("input") in unknown:
            out[m["input"]] = {"name": m["match"], "score": float(m.get("confidence") or 0),
                               "reason": "IA : " + (m.get("reason") or "")}
    return out


def test(cfg: dict) -> dict:
    """Appel d'essai avec des noms fictifs : vérifie clé, modèle et niveau de raisonnement."""
    t = time.time()
    res = match_names(["jerome.martin", "DUPONT Marie", "Paul Inconnu"], ["Jérôme Martin", "Marie Dupont", "Luc Bernard"],
                      cfg=cfg, raise_errors=True)
    return {"ok": True, "seconds": round(time.time() - t, 1), "matches": res}
