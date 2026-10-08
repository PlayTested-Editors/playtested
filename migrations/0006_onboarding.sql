-- Welcome tour: shown once, to people who join after this ships. Everyone
-- already on the team counts as onboarded.
ALTER TABLE users ADD COLUMN onboarded_at INTEGER;
UPDATE users SET onboarded_at = created_at;
