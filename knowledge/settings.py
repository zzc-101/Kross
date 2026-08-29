from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="KNOWLEDGE_", extra="ignore")

    internal_token: str = ""
    database_url: str = "postgresql://kross:kross@127.0.0.1:5432/kross"
    embedding_provider: str = "hash"
    embedding_base_url: str = ""
    embedding_api_key: str = ""
    embedding_model: str = ""
    embedding_dim: int = 1024


def load_settings() -> Settings:
    return Settings()
