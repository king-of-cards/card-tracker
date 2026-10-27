use strict;
use warnings;
use LWP::UserAgent;
use JSON;

my $ua  = LWP::UserAgent->new;
my $url = 'http://localhost:8080/api/memberStageDetail?division=KOC%20Cards';

my $response = $ua->get($url);

print "Status Code: ", $response->code, "\n";

if ($response->is_success) {
    my $data = decode_json($response->decoded_content);

    print "\n--- Full pretty-printed response ---\n";
    my $json = JSON->new->pretty->canonical;
    print $json->encode($data);

    print "\n--- Quick check: assignedAt / completedAt per stage ---\n";
    if ($data->{members}) {
        foreach my $member (@{$data->{members}}) {
            print "\nMember: $member->{memberName} ($member->{division})\n";
            foreach my $stage (@{$member->{stages}}) {
                my $assigned  = $stage->{assignedAt}  // 'null';
                my $completed = $stage->{completedAt} // 'null';
                print "  Stage: $stage->{stage} | assignedAt: $assigned | completedAt: $completed\n";
            }
        }
    } else {
        print "No 'members' array found in response.\n";
    }
} else {
    print "Response Body:\n", $response->decoded_content, "\n";
}