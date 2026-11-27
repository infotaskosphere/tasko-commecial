from backend.engagex import router as ex


def test_campaign_from_name_is_stored_per_campaign():
    body = ex.MailCampaignIn(name="Black Friday", sender_id="exs_1", from_name="  Prodigist Ventures Private Limited ")
    assert ex._mail_fields(body)["settings"]["from_name"] == "Prodigist Ventures Private Limited"


def test_blank_campaign_from_name_keeps_mailbox_name():
    body = ex.MailCampaignIn(name="Newsletter", sender_id="exs_1")
    assert ex._mail_fields(body)["settings"]["from_name"] is None
