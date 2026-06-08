from pydantic import BaseModel, Field, field_validator, model_validator

from settings import config


def validate_text_limits(values: list[str], field_name: str) -> None:
    # Character limits are request safety guards. Semantic chunking is token-based.
    total_chars = 0
    for index, value in enumerate(values):
        char_count = len(value)
        if char_count > config.embedding_max_text_chars:
            raise ValueError(
                f"{field_name}[{index}] exceeds maximum length of "
                f"{config.embedding_max_text_chars} characters"
            )
        total_chars += char_count
    if total_chars > config.embedding_max_request_chars:
        raise ValueError(
            f"{field_name} exceeds maximum total length of "
            f"{config.embedding_max_request_chars} characters"
        )


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1)

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, texts: list[str]) -> list[str]:
        if len(texts) > config.batch_limit:
            raise ValueError(f"too many texts; maximum batch size is {config.batch_limit}")
        for index, text in enumerate(texts):
            if not text or not text.strip():
                raise ValueError(f"texts[{index}] must not be empty")
        validate_text_limits(texts, "texts")
        return texts


class EmbeddedChunk(BaseModel):
    inputIndex: int
    chunkIndex: int
    chunkCount: int
    tokenCount: int
    text: str
    vector: list[float]


class EmbedResponse(BaseModel):
    model: str
    dimensions: int
    measuredTokens: int | None = None
    vectors: list[list[float]]
    chunks: list[EmbeddedChunk]


class RerankRequest(BaseModel):
    query: str = Field(min_length=1)
    documents: list[str] = Field(min_length=1)

    @field_validator("query")
    @classmethod
    def validate_query(cls, query: str) -> str:
        if not query.strip():
            raise ValueError("query must not be empty")
        validate_text_limits([query], "query")
        return query

    @field_validator("documents")
    @classmethod
    def validate_documents(cls, documents: list[str]) -> list[str]:
        if len(documents) > config.reranker_batch_limit:
            raise ValueError(
                f"too many documents; maximum batch size is {config.reranker_batch_limit}"
            )
        for index, document in enumerate(documents):
            if not document or not document.strip():
                raise ValueError(f"documents[{index}] must not be empty")
        validate_text_limits(documents, "documents")
        return documents

    @model_validator(mode="after")
    def validate_total_chars(self) -> "RerankRequest":
        validate_text_limits([self.query, *self.documents], "request")
        return self


class RerankResponse(BaseModel):
    model: str
    scores: list[float]
