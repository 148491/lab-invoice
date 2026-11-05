"""Rapprochement des noms de collaborateurs entre les fichiers.

Un seul nom fait foi : celui du référentiel des collaborateurs. Toute autre
graphie (« Marie DUPONT », « DUPONT Marie », « jerome.martin ») est
rattachée à ce nom, soit automatiquement (même nom à la casse, aux accents,
à la ponctuation et à l'ordre des mots près, ou alias enregistré), soit après
confirmation d'une suggestion (similarité, initiales, translittération, IA).
"""
from __future__ import annotations

import json
import re
import unicodedata
from difflib import SequenceMatcher


def norm(name: str | None) -> str:
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"@.*$", "", s)                      # adresse e-mail : on garde la partie locale
    s = re.sub(r"[._\-'’]+", " ", s).casefold()
    return " ".join(s.split())


def key(name: str | None) -> str:
    """Clé insensible à l'ordre des mots (« DUPONT Marie » == « Marie Dupont »)."""
    return " ".join(sorted(norm(name).split()))


_TRANSLIT = [("yeh", "ye"), ("ie", "ye"), ("ii", "y"), ("iy", "y"), ("ei", "ey"), ("kh", "h"), ("ck", "k"),
             ("ph", "f"), ("w", "v"), ("ou", "u"), ("oo", "u"), ("sch", "sh"), ("tch", "ch"), ("tz", "ts"),
             ("j", "y"), ("c", "k"), ("q", "k"), ("x", "ks")]


def phon(s: str) -> str:
    s = norm(s)
    for a, b in _TRANSLIT:
        s = s.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", s)


def similarity(a: str, b: str) -> tuple[float, str]:
    """Score 0..1 et raison lisible."""
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0, ""
    if key(a) == key(b):
        return 1.0, "même nom"
    ta, tb = na.split(), nb.split()
    best, why = SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio(), "orthographe proche"
    p = SequenceMatcher(None, " ".join(sorted(phon(x) for x in ta)), " ".join(sorted(phon(x) for x in tb))).ratio()
    if p > best:
        best, why = p, "prononciation proche"
    # « J. Martin », « jmartin », prénom seul + nom identique
    if len(ta) >= 1 and len(tb) >= 2:
        last_a, last_b = ta[-1], tb[-1]
        if (last_a == last_b or last_a == tb[0]) and ta[0][:1] in (tb[0][:1], tb[-1][:1]):
            if max(best, 0.9) > best:
                best, why = 0.9, "initiale + nom"
    joined_a, joined_b = na.replace(" ", ""), nb.replace(" ", "")
    if joined_a == joined_b or joined_a == (tb[0][:1] + tb[-1] if len(tb) > 1 else ""):
        best, why = max(best, 0.92), "nom collé"
    if set(ta) < set(tb) or set(tb) < set(ta):
        if 0.85 > best:
            best, why = 0.85, "nom partiel"
    return round(best, 3), why


class Resolver:
    """Associe n'importe quelle graphie au nom canonique du référentiel."""

    def __init__(self, collaborators: list[dict]):
        self.names = [c["name"] for c in collaborators]
        self.by_key: dict[str, str] = {}
        for c in collaborators:
            self.by_key.setdefault(key(c["name"]), c["name"])
            for a in json.loads(c.get("aliases") or "[]"):
                self.by_key.setdefault(key(a), c["name"])

    def __call__(self, name: str | None) -> str:
        if not name:
            return ""
        return self.by_key.get(key(name), " ".join(str(name).split()))

    def known(self, name: str | None) -> bool:
        return key(name) in self.by_key

    def suggest(self, name: str, limit: int = 3, threshold: float = 0.6) -> list[dict]:
        out = []
        for n in self.names:
            sc, why = similarity(name, n)
            if sc >= threshold:
                out.append({"name": n, "score": sc, "reason": why})
        out.sort(key=lambda x: -x["score"])
        return out[:limit]
