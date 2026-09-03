from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field, HttpUrl


class ParticipantIn(BaseModel):
    participant_id: str
    phone: str
    redcap_record_id: str | None = None
    status: str = "active"


class ParticipantOut(ParticipantIn):
    id: int


class StudyWindow(BaseModel):
    start: str
    end: str
    link: HttpUrl


class AdditionalDailySurvey(BaseModel):
    survey_type: str
    time: str | None = None
    link: HttpUrl | None = None
    message: str | None = None


class StudyIn(BaseModel):
    participant_id: int
    comments: str = ""
    start_date: str
    end_date: str
    prompts_per_day: int = Field(default=4, ge=1, le=8)
    windows: List[StudyWindow] = Field(default_factory=list)
    additional_surveys: List[AdditionalDailySurvey] = Field(default_factory=list)


class StudyOut(StudyIn):
    id: int
