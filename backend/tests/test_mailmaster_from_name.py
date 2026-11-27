from backend.engagex import router as ex


def test_campaign_from_name_is_stored_per_campaign():
    body = ex.MailCampaignIn(name="Black Friday", sender_id="exs_1", from_name="  Prodigist Ventures Private Limited ")
    assert ex._mail_fields(body)["settings"]["from_name"] == "Prodigist Ventures Private Limited"


def test_blank_campaign_from_name_keeps_mailbox_name():
    body = ex.MailCampaignIn(name="Newsletter", sender_id="exs_1")
    assert ex._mail_fields(body)["settings"]["from_name"] is None


def test_launched_campaign_responses_never_carry_the_recipient_list():
    recipients = [{"email": f"r{i}@x.example", "name": f"R{i}"} for i in range(10_000)]
    running = ex._public_campaign({"id": "c1", "status": "running", "audience": {"list_ids": [], "recipients": recipients}})
    assert "recipients" not in running["audience"] and running["audience"]["recipient_count"] == 10_000
    draft = ex._public_campaign({"id": "c2", "status": "draft", "audience": {"list_ids": [], "recipients": recipients[:3]}})
    assert len(draft["audience"]["recipients"]) == 3  # drafts stay editable
